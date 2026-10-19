import * as fs from "node:fs";
import * as path from "node:path";
import { MERGE_DIR } from "./filter.js";
import { hasConflictMarkers } from "./merge.js";
import { writeSourcePatch } from "./mergePrep.js";
import type { SandboxEntry } from "./registry.js";
import type { Workspace } from "./workspace.js";

/**
 * Why a pair cannot take part in a merge right now (files waiting for a
 * decision, changes not synced yet, sync stopped…), or null when it can.
 * Supplied by whoever runs the syncers.
 */
export type SettledCheck = (pair: string) => string | null;

export interface MergeOutcome {
  target: string;
  /** Sources merged (and committed) during this call. */
  merged: string[];
  /** Source whose merge stopped on conflicts; null when everything is merged. */
  stoppedAt: string | null;
  /** Conflicted files (project paths, relative to the worktree). */
  conflicts: string[];
  /** Folder with notes for the agent (in the target sandbox), when stopped. */
  notesDir: string | null;
  /** Real names found in the notes — should always be empty. */
  leaks: string[];
}

/**
 * Merge the work of `sources` into `target` with real git merges, source by
 * source, in the target's worktree:
 *
 *  1. the source's uncommitted work is committed to its branch;
 *  2. `git merge --no-ff <source branch>` runs in the target worktree;
 *  3. without conflicts the merge commit is made and the next source follows;
 *     the result reaches the target sandbox through the normal live sync;
 *  4. on conflicts the merge stays in progress: the files with conflict
 *     markers sync into the target sandbox (anonymized), and
 *     `.anonymus-merge/` there gets CONFLICTS.txt plus the source's patch for
 *     the agent who resolves them. `continueMerge` picks up from there.
 */
export function startMerge(ws: Workspace, target: string, sources: string[], settled: SettledCheck): MergeOutcome {
  const registry = ws.registry;
  if (!registry) {
    throw new Error("проект не является git-репозиторием");
  }
  const entry = registry.get(target);
  if (!entry) {
    throw new Error(`нет подпесочницы «${target}»`);
  }
  if (entry.merge?.current) {
    throw new Error(`в «${target}» уже идёт слияние ${entry.merge.current}: k — продолжить, a — прервать`);
  }
  const picked = sources.filter((s) => s !== target);
  if (picked.length === 0) {
    throw new Error("не выбрано ни одной подпесочницы для слияния");
  }
  for (const name of [target, ...picked]) {
    if (!registry.get(name)) {
      throw new Error(`нет подпесочницы «${name}»`);
    }
    const why = settled(name);
    if (why) {
      throw new Error(`«${name}»: ${why}`);
    }
  }
  const git = ws.gitOf(target);
  if (git.mergeInProgress()) {
    throw new Error(`в worktree «${target}» уже идёт git merge — завершите или прервите его`);
  }
  if (git.isDirty()) {
    throw new Error(`в «${target}» есть незакоммиченные изменения — сначала закоммитьте их (k)`);
  }
  entry.merge = { sources: picked, done: [], current: null };
  registry.save();
  return run(ws, entry);
}

/**
 * The conflicts of the current source are resolved (no markers left, the
 * target pair is in sync): commit that merge and go on with the next sources.
 */
export function continueMerge(ws: Workspace, target: string, settled: SettledCheck): MergeOutcome {
  const entry = ws.registry?.get(target);
  const current = entry?.merge?.current;
  if (!entry || !current) {
    throw new Error(`в «${target}» нет начатого слияния`);
  }
  const why = settled(target);
  if (why) {
    throw new Error(`«${target}»: ${why}`);
  }
  const git = ws.gitOf(target);
  if (git.mergeInProgress()) {
    const left = unresolved(entry, git.conflictedFiles());
    if (left.length > 0) {
      throw new Error(
        `маркеры конфликта ещё в ${left.length} ${left.length === 1 ? "файле" : "файлах"}: ${left.slice(0, 3).join(", ")}` +
          (left.length > 3 ? " …" : "")
      );
    }
    git.commitMerge();
  }
  // Without a merge in progress the user finished it with git themselves.
  entry.merge!.done.push(current);
  entry.merge!.current = null;
  ws.registry!.save();
  return run(ws, entry);
}

/** Abort the merge in progress (git merge --abort) and forget the run. */
export function abortMerge(ws: Workspace, target: string): void {
  const entry = ws.registry?.get(target);
  if (!entry?.merge) {
    throw new Error(`в «${target}» нет начатого слияния`);
  }
  const git = ws.gitOf(target);
  if (git.mergeInProgress()) {
    git.mergeAbort();
  }
  entry.merge = null;
  ws.registry!.save();
  removeNotes(entry);
}

function run(ws: Workspace, entry: SandboxEntry): MergeOutcome {
  const registry = ws.registry!;
  const merge = entry.merge!;
  const git = ws.gitOf(entry.name);
  const merged: string[] = [];
  for (const name of merge.sources) {
    if (merge.done.includes(name)) {
      continue;
    }
    const source = registry.get(name);
    if (!source) {
      merge.done.push(name); // removed meanwhile: nothing left to merge
      continue;
    }
    const sourceGit = ws.gitOf(name);
    sourceGit.commitAll(`anonymus: работа ${name}`);
    // The common ancestor, taken before the merge moves anything.
    const baseCommit = ws.git!.mergeBase(entry.branch, source.branch);
    const result = git.merge(source.branch, `Слияние ${name} в ${entry.name} (anonymus)`);
    if (!result.ok) {
      merge.current = name;
      registry.save();
      const notes = writeNotes(ws, entry, source, baseCommit, result.conflicts);
      return { target: entry.name, merged, stoppedAt: name, conflicts: result.conflicts, ...notes };
    }
    merge.done.push(name);
    merged.push(name);
    registry.save();
  }
  entry.merge = null;
  registry.save();
  removeNotes(entry);
  return { target: entry.name, merged, stoppedAt: null, conflicts: [], notesDir: null, leaks: [] };
}

/** Conflicted files that still carry conflict markers (binary files are the user's call). */
function unresolved(entry: SandboxEntry, conflicted: string[]): string[] {
  return conflicted.filter((file) => {
    const abs = path.join(entry.worktree, ...file.split("/"));
    try {
      // Markers are ASCII: latin1 reads them in any encoding (win1251 included).
      return hasConflictMarkers(fs.readFileSync(abs, "latin1"));
    } catch {
      return false; // deleted while resolving: that is a resolution too
    }
  });
}

/**
 * Notes for the agent in the target sandbox (sandbox form only, never synced):
 * the conflicted files and what the source did since the common ancestor.
 */
function writeNotes(
  ws: Workspace,
  target: SandboxEntry,
  source: SandboxEntry,
  baseCommit: string,
  conflicts: string[]
): { notesDir: string; leaks: string[] } {
  const engine = ws.engineFor(target.name);
  const t = engine.transformer;
  const dir = path.join(target.sandbox, MERGE_DIR);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const sourceName = t.anonymize(source.name).text;
  const targetName = t.anonymize(target.name).text;
  const patchName = `${t.anonymizePath(source.name.replace(/[\\/:*?"<>|\s]+/g, "-"))}.patch`;
  const patch = writeSourcePatch(ws, source, target, baseCommit, path.join(dir, patchName));

  const lines = conflicts.map((file) => {
    const shown = engine.mapper.toSandbox(file);
    return engine.filter.isBinary(file) ? `${shown}   (бинарный — выберите версию вручную)` : shown;
  });
  const text =
    `Слияние ветки ${sourceName} в ${targetName}: git остановился на конфликтах.\n\n` +
    "Файлы с маркерами конфликта (<<<<<<< ======= >>>>>>>):\n" +
    lines.map((l) => `  ${l}`).join("\n") +
    "\n\n" +
    "Что сделать:\n" +
    "  1. В каждом файле разрешите конфликт: сохраните намерения обеих сторон, уберите маркеры.\n" +
    `     Что вообще меняла ветка ${sourceName}: ${MERGE_DIR}/${patchName}.\n` +
    "  2. Кодировку и концы строк файлов не меняйте.\n" +
    "  3. Соберите и проверьте проект.\n" +
    "  4. Ничего не коммитьте — коммит слияния сделает человек.\n";
  fs.writeFileSync(path.join(dir, "CONFLICTS.txt"), text, "utf8");
  return { notesDir: dir, leaks: [...new Set([...patch.leaks, ...t.findLeaks(text)])] };
}

function removeNotes(entry: SandboxEntry): void {
  fs.rmSync(path.join(entry.sandbox, MERGE_DIR), { recursive: true, force: true });
}
