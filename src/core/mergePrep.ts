import * as fs from "node:fs";
import * as path from "node:path";
import { structuredPatch, type Hunk } from "diff";
import { encode, type Encoding } from "./encoding.js";
import type { SyncEngine } from "./engine.js";
import { decodeText, readBytes, sameText, walkFiles, type Eol, type TextFile } from "./fileio.js";
import type { SandboxEntry } from "./registry.js";
import type { Workspace } from "./workspace.js";

export interface SourcePatch {
  /** Absolute path of the written patch file. */
  file: string;
  modified: number;
  added: number;
  deleted: number;
  /** Binary files that differ (listed in the patch, not diffable). */
  binary: number;
  /** Real names found in the patch — should always be empty. */
  leaks: string[];
}

/** Pairs branched off `target` — the natural sources to merge into it. */
export function defaultMergeSources(ws: Workspace, target: string): string[] {
  const t = ws.registry?.get(target);
  return (ws.registry?.list() ?? [])
    .filter((s) => s.name !== target && t && s.base?.branch === t.branch)
    .map((s) => s.name);
}

/**
 * What `source` changed since `baseCommit`, as a unified diff (git format) in
 * sandbox form — placeholders only — written to `file`. The agent resolving
 * a merge conflict reads it to understand what the other side meant.
 */
export function writeSourcePatch(
  ws: Workspace,
  source: SandboxEntry,
  target: SandboxEntry,
  baseCommit: string,
  file: string
): SourcePatch {
  const engine = ws.engineFor(source.name);
  const { patch, text, stats } = diffSourceAgainstBase(ws, engine, source, target, baseCommit);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, patch);
  return { file, ...stats, leaks: engine.transformer.findLeaks(text) };
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
  const targetRoot = target.sandbox;

  // Base: files of the common ancestor, by canonical (real) path.
  const base = new Set<string>();
  for (const file of git.listFiles(baseCommit)) {
    if (filter.isSynced(file) && !mapper.projectPathProblem(file)) {
      base.add(file);
    }
  }
  // Source: the sub-sandbox folder as it is now.
  const current = new Set<string>();
  const root = source.sandbox;
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
