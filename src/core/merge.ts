import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { diff3Merge } from "node-diff3";
import { SERVICE_DIR } from "../config/schema.js";

/** Split into lines keeping each line's own terminator (so EOLs survive). */
function lines(text: string): string[] {
  return text.length === 0 ? [] : text.split(/(?<=\n)/);
}

/** Make sure a block ends with a newline before a conflict marker line. */
function terminated(block: string[], eol: string): string[] {
  if (block.length === 0) {
    return block;
  }
  const last = block[block.length - 1];
  return last.endsWith("\n") ? block : [...block.slice(0, -1), last + eol];
}

export interface Diff3Result {
  text: string;
  conflict: boolean;
}

/**
 * Line-based three-way merge. Line endings are normalized to LF first, so a
 * file whose EOL style differs between sides still merges cleanly; callers
 * re-apply each target's EOL style when writing. Conflicting regions are
 * written with git-style markers.
 */
export function diff3Text(
  ours: string,
  base: string,
  theirs: string,
  labels = { ours: "проект", theirs: "песочница" }
): Diff3Result {
  const norm = (t: string) => t.replace(/\r\n/g, "\n");
  const regions = diff3Merge(lines(norm(ours)), lines(norm(base)), lines(norm(theirs)), {
    excludeFalseConflicts: true,
  });
  const out: string[] = [];
  let conflict = false;
  for (const region of regions) {
    if (region.ok) {
      out.push(...region.ok);
    } else if (region.conflict) {
      conflict = true;
      out.push(`<<<<<<< ${labels.ours}\n`);
      out.push(...terminated(region.conflict.a, "\n"));
      out.push(`=======\n`);
      out.push(...terminated(region.conflict.b, "\n"));
      out.push(`>>>>>>> ${labels.theirs}\n`);
    }
  }
  return { text: out.join(""), conflict };
}

export function hasConflictMarkers(text: string): boolean {
  return /^(<{7}|>{7})( |$)/m.test(text);
}

export interface EditorMergeInput {
  projectRoot: string;
  canonical: string;
  /** All three in PROJECT form (real names), easier for a human to read. */
  ours: string;
  theirs: string;
  base: string;
}

export type EditorMergeResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

/**
 * Resolve a conflict in the three-way merge editor of VS Code:
 * `code --wait --merge <ours> <theirs> <base> <result>`. The temporary files
 * live in the project's `.anonymus/merge/` (never in the sandbox). Resolves
 * once the editor tab is closed.
 */
export async function mergeInEditor(input: EditorMergeInput): Promise<EditorMergeResult> {
  const name = path.posix.basename(input.canonical);
  const id = `${input.canonical.replace(/[\\/:*?"<>|]/g, "_")}-${Date.now()}`;
  const dir = path.join(input.projectRoot, SERVICE_DIR, "merge", id);
  fs.mkdirSync(dir, { recursive: true });

  const file = (label: string) => path.join(dir, `${label}.${name}`);
  const ours = file("проект");
  const theirs = file("песочница");
  const base = file("база");
  const result = file("результат");
  fs.writeFileSync(ours, input.ours, "utf8");
  fs.writeFileSync(theirs, input.theirs, "utf8");
  fs.writeFileSync(base, input.base, "utf8");
  // Pre-fill the result with what diff3 could merge, conflicts marked.
  fs.writeFileSync(result, diff3Text(input.ours, input.base, input.theirs).text, "utf8");

  const exit = await runCode(["--wait", "--merge", ours, theirs, base, result]);
  if (exit !== 0) {
    return {
      ok: false,
      reason:
        exit === null
          ? "не удалось запустить VS Code: команда `code` не найдена в PATH"
          : `VS Code завершился с кодом ${exit}`,
    };
  }
  const text = fs.readFileSync(result, "utf8");
  if (hasConflictMarkers(text)) {
    return { ok: false, reason: "в результате остались маркеры конфликта <<<<<<< / >>>>>>>" };
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true, text };
}

/** Run the `code` CLI (code.cmd on Windows); resolves to the exit code or null. */
function runCode(args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const quoted = args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a));
    const child = spawn("code", quoted, { shell: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => resolve(null));
    child.on("exit", (code) => resolve(code === 9009 || code === 127 ? null : code));
  });
}
