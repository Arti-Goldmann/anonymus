import * as fs from "node:fs";
import * as path from "node:path";
import { structuredPatch } from "diff";
import type { SyncEngine } from "./engine.js";
import { decodeText, sameText, walkFiles } from "./fileio.js";
import { MERGE_DIR } from "./filter.js";
import type { SandboxEntry } from "./registry.js";
import type { Workspace } from "./workspace.js";

export interface MergeSourceResult {
  name: string;
  /** Patch file, relative to the target sub-sandbox. */
  patch: string;
  modified: number;
  added: number;
  deleted: number;
  /** Binary files that differ (listed in the patch, not diffable). */
  binary: number;
  /** Real names found in the patch — should always be empty. */
  leaks: string[];
}

export interface MergePrepResult {
  /** Absolute path of the `.anonymus-merge` folder in the target sub-sandbox. */
  dir: string;
  sources: MergeSourceResult[];
}

/** Sub-sandboxes branched off `target` — the natural sources to merge into it. */
export function defaultMergeSources(ws: Workspace, target: string): string[] {
  const t = ws.registry.get(target);
  return ws.registry
    .list()
    .filter((s) => s.name !== target && t?.branch && s.base?.branch === t.branch)
    .map((s) => s.name);
}

/**
 * Prepare the work of `sources` for an agent in `target` to merge: for each
 * source, a unified diff (git format) from the common ancestor to the
 * source's sub-sandbox folder as it is right now — including agent work that
 * was never synced to git. Everything is in sandbox form (placeholders only)
 * and lands in `<target sandbox>/.anonymus-merge/`, which is never synced.
 */
export function prepareMerge(ws: Workspace, target: string, sources: string[]): MergePrepResult {
  const git = ws.git;
  if (!git) {
    throw new Error("проект не является git-репозиторием");
  }
  const targetEntry = ws.registry.get(target);
  if (!targetEntry?.branch) {
    throw new Error(`нет подпесочницы «${target}» с веткой`);
  }
  if (sources.length === 0) {
    throw new Error("не выбрано ни одной подпесочницы для слияния");
  }

  const dir = path.join(ws.registry.absPath(targetEntry), MERGE_DIR);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const results: MergeSourceResult[] = [];
  for (const name of sources) {
    const source = ws.registry.get(name);
    if (!source?.branch) {
      throw new Error(`нет подпесочницы «${name}» с веткой`);
    }
    const baseCommit =
      source.base && source.base.branch === targetEntry.branch
        ? source.base.commit
        : git.mergeBase(targetEntry.branch, source.branch);
    const engine = ws.engineFor(source);
    const { patch, stats } = diffSourceAgainstBase(ws, engine, source, baseCommit);
    const file = `${name.replace(/[\\/:*?"<>|\s]+/g, "-")}.patch`;
    fs.writeFileSync(path.join(dir, file), patch, "utf8");
    results.push({ name, patch: `${MERGE_DIR}/${file}`, ...stats, leaks: engine.transformer.findLeaks(patch) });
  }

  const index = results
    .map(
      (r) =>
        `${r.patch}: изменено ${r.modified}, добавлено ${r.added}, удалено ${r.deleted}` +
        (r.binary ? `, бинарных ${r.binary} (только в списке)` : "")
    )
    .join("\n");
  fs.writeFileSync(
    path.join(dir, "index.txt"),
    `Изменения подпесочниц относительно общей основы (git-формат, строки с LF):\n${index}\n`,
    "utf8"
  );

  targetEntry.mergeSources = sources;
  ws.registry.save();
  return { dir, sources: results };
}

interface DiffStats {
  modified: number;
  added: number;
  deleted: number;
  binary: number;
}

function diffSourceAgainstBase(
  ws: Workspace,
  engine: SyncEngine,
  source: SandboxEntry,
  baseCommit: string
): { patch: string; stats: DiffStats } {
  const git = ws.git!;
  const filter = engine.filter;
  const mapper = engine.mapper;

  // Base: files of the common ancestor, by canonical (real) path.
  const base = new Set<string>();
  for (const file of git.listFiles(baseCommit)) {
    if (filter.isSynced(file) && !mapper.projectPathProblem(file)) {
      base.add(file);
    }
  }
  // Source: the sub-sandbox folder as it is now.
  const current = new Set<string>();
  const root = ws.registry.absPath(source);
  for (const rel of walkFiles(root, (d) => filter.isDirExcluded(mapper.toCanonical(d)))) {
    const canonical = mapper.toCanonical(rel);
    if (filter.isSynced(canonical) && !mapper.sandboxPathProblem(rel)) {
      current.add(canonical);
    }
  }

  const sandboxSetting = (bytes: Buffer) => engine.decodeSide("sandbox", bytes).text;
  const baseText = (canonical: string) =>
    engine.transformer.anonymize(
      decodeText(git.readFile(baseCommit, canonical), engine.config.sync.encoding).text
    ).text;
  const lf = (t: string) => t.replace(/\r\n/g, "\n");

  const stats: DiffStats = { modified: 0, added: 0, deleted: 0, binary: 0 };
  const parts: string[] = [];
  for (const canonical of [...new Set([...base, ...current])].sort()) {
    const p = mapper.toSandbox(canonical);
    const inBase = base.has(canonical);
    const inCurrent = current.has(canonical);
    const currentBytes = inCurrent ? fs.readFileSync(path.join(root, ...p.split("/"))) : null;

    if (filter.isBinary(canonical)) {
      const baseBytes = inBase ? git.readFile(baseCommit, canonical) : null;
      if (baseBytes && currentBytes && baseBytes.equals(currentBytes)) continue;
      stats.binary++;
      parts.push(`diff --git a/${p} b/${p}\nBinary files ${inBase ? `a/${p}` : "/dev/null"} and ${inCurrent ? `b/${p}` : "/dev/null"} differ\n`);
      continue;
    }

    const before = inBase ? baseText(canonical) : "";
    const after = currentBytes ? sandboxSetting(currentBytes) : "";
    if (inBase && inCurrent && sameText(before, after)) continue;

    const hunks = structuredPatch(`a/${p}`, `b/${p}`, lf(before), lf(after), "", "", { context: 3 }).hunks;
    let header = `diff --git a/${p} b/${p}\n`;
    if (!inBase) {
      stats.added++;
      header += `new file mode 100644\n--- /dev/null\n+++ b/${p}\n`;
    } else if (!inCurrent) {
      stats.deleted++;
      header += `deleted file mode 100644\n--- a/${p}\n+++ /dev/null\n`;
    } else {
      stats.modified++;
      header += `--- a/${p}\n+++ b/${p}\n`;
    }
    const body = hunks
      .map((h) => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join("\n")}\n`)
      .join("");
    parts.push(header + body);
  }
  return { patch: parts.join(""), stats };
}
