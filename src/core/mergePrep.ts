import * as fs from "node:fs";
import * as path from "node:path";
import { structuredPatch, type Hunk } from "diff";
import { encode, type Encoding } from "./encoding.js";
import type { SyncEngine } from "./engine.js";
import { decodeText, readBytes, sameText, walkFiles, type Eol, type TextFile } from "./fileio.js";
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
    const { patch, text, stats } = diffSourceAgainstBase(ws, engine, source, targetEntry, baseCommit);
    const file = `${name.replace(/[\\/:*?"<>|\s]+/g, "-")}.patch`;
    fs.writeFileSync(path.join(dir, file), patch);
    results.push({ name, patch: `${MERGE_DIR}/${file}`, ...stats, leaks: engine.transformer.findLeaks(text) });
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
    "Изменения подпесочниц относительно общей основы, git-формат.\n" +
      "Каждый кусок записан в кодировке и с концами строк своего файла в этой песочнице:\n" +
      "патчи применяются как есть (git apply), перекодировать ничего не нужно.\n\n" +
      `${index}\n`,
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

/** How a file is stored on disk: the patch for it must use the same bytes. */
interface FileStyle {
  encoding: Encoding;
  eol: Eol;
  bom: boolean;
}

/**
 * One file's diff as bytes: header lines in UTF-8 (git paths), hunk lines in
 * the file's own encoding and line endings, so `git apply` matches the file
 * byte for byte (CRLF and Windows-1251 files included).
 */
function renderFileDiff(header: string, hunks: Hunk[], style: FileStyle): Buffer {
  const chunks: Buffer[] = [Buffer.from(header, "utf8")];
  for (const h of hunks) {
    chunks.push(Buffer.from(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n`, "utf8"));
    let oldLine = h.oldStart;
    let newLine = h.newStart;
    for (const line of h.lines) {
      if (line.startsWith("\\")) {
        chunks.push(Buffer.from(`${line}\n`, "utf8")); // "\ No newline at end of file"
        continue;
      }
      const kind = line[0];
      let content = line.slice(1);
      const firstLine = (kind !== "+" && oldLine === 1) || (kind === "+" && newLine === 1);
      if (style.bom && firstLine) {
        content = "﻿" + content; // the BOM sits in front of line 1 on disk
      }
      if (kind !== "+") oldLine++;
      if (kind !== "-") newLine++;
      // The line terminator is only emitted when the line really has one: jsdiff
      // marks the last line without a newline with a following "\" line.
      const eol = style.eol === "\r\n" ? "\r\n" : "\n";
      chunks.push(Buffer.from(kind, "utf8"), encode(content, style.encoding), Buffer.from(eol, "utf8"));
    }
  }
  return fixMissingNewlines(Buffer.concat(chunks));
}

/**
 * jsdiff emits "\ No newline at end of file" after a line that has no
 * terminator, but renderFileDiff already added one; drop it again (and the
 * CR before it) so git sees the line exactly as it is in the file.
 */
function fixMissingNewlines(patch: Buffer): Buffer {
  const marker = Buffer.from("\n\\ No newline at end of file\n", "utf8");
  const parts: Buffer[] = [];
  let from = 0;
  for (let i = patch.indexOf(marker, from); i !== -1; i = patch.indexOf(marker, from)) {
    let end = i; // position of the terminator we added
    if (end > 0 && patch[end - 1] === 0x0d) end--;
    parts.push(patch.subarray(from, end), marker);
    from = i + marker.length;
  }
  parts.push(patch.subarray(from));
  return Buffer.concat(parts);
}

function diffSourceAgainstBase(
  ws: Workspace,
  engine: SyncEngine,
  source: SandboxEntry,
  target: SandboxEntry,
  baseCommit: string
): { patch: Buffer; text: string; stats: DiffStats } {
  const git = ws.git!;
  const filter = engine.filter;
  const mapper = engine.mapper;
  const targetRoot = ws.registry.absPath(target);

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

  const baseText = (canonical: string) =>
    engine.transformer.anonymize(
      decodeText(git.readFile(baseCommit, canonical), engine.config.sync.encoding).text
    ).text;
  const lf = (t: string) => t.replace(/\r\n/g, "\n");
  /** Style of `p` in the target sandbox — or, for a new file, in the source. */
  const styleOf = (p: string, sourceFile: TextFile | null): FileStyle => {
    const targetBytes = readBytes(path.join(targetRoot, ...p.split("/")));
    const file = targetBytes ? engine.decodeSide("sandbox", targetBytes) : sourceFile;
    return {
      encoding: file?.encoding ?? "utf8",
      eol: file?.eol ?? (file && /\r\n/.test(file.text) ? "\r\n" : "\n"),
      bom: file?.bom ?? false,
    };
  };

  const stats: DiffStats = { modified: 0, added: 0, deleted: 0, binary: 0 };
  const parts: Buffer[] = [];
  const texts: string[] = [];
  for (const canonical of [...new Set([...base, ...current])].sort()) {
    const p = mapper.toSandbox(canonical);
    const inBase = base.has(canonical);
    const inCurrent = current.has(canonical);
    const currentBytes = inCurrent ? fs.readFileSync(path.join(root, ...p.split("/"))) : null;

    if (filter.isBinary(canonical)) {
      const baseBytes = inBase ? git.readFile(baseCommit, canonical) : null;
      if (baseBytes && currentBytes && baseBytes.equals(currentBytes)) continue;
      stats.binary++;
      const note = `diff --git a/${p} b/${p}\nBinary files ${inBase ? `a/${p}` : "/dev/null"} and ${inCurrent ? `b/${p}` : "/dev/null"} differ\n`;
      parts.push(Buffer.from(note, "utf8"));
      texts.push(note);
      continue;
    }

    const sourceFile = currentBytes ? engine.decodeSide("sandbox", currentBytes) : null;
    const before = inBase ? baseText(canonical) : "";
    const after = sourceFile?.text ?? "";
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
    parts.push(renderFileDiff(header, hunks, styleOf(p, sourceFile)));
    texts.push(header + hunks.map((h) => h.lines.join("\n")).join("\n"));
  }
  return { patch: Buffer.concat(parts), text: texts.join("\n"), stats };
}
