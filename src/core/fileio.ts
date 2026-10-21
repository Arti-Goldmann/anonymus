import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { decode, encode, resolveEncoding, type Encoding, type EncodingSetting } from "./encoding.js";

export type Eol = "\n" | "\r\n";

/** A decoded text file plus everything needed to write it back faithfully. */
export interface TextFile {
  /** Content without a BOM. */
  text: string;
  encoding: Encoding;
  bom: boolean;
  /** Uniform line-ending style, or null for mixed / single-line files. */
  eol: Eol | null;
}

export function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** File bytes, or null if the file does not exist (or is not a file). */
export function readBytes(absPath: string): Buffer | null {
  try {
    return fs.readFileSync(absPath);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR") {
      return null;
    }
    throw e;
  }
}

export function detectEol(text: string): Eol | null {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/(?<!\r)\n/g) || []).length;
  if (crlf > 0 && lf === 0) {
    return "\r\n";
  }
  if (lf > 0 && crlf === 0) {
    return "\n";
  }
  return null;
}

/** Rewrite every line break to `eol`. */
export function applyEol(text: string, eol: Eol): string {
  const lf = text.replace(/\r\n/g, "\n");
  return eol === "\n" ? lf : lf.replace(/\n/g, "\r\n");
}

export function decodeText(bytes: Uint8Array, setting: EncodingSetting): TextFile {
  const encoding = resolveEncoding(bytes, setting);
  let text = decode(bytes, encoding);
  const bom = text.charCodeAt(0) === 0xfeff;
  if (bom) {
    text = text.slice(1);
  }
  return { text, encoding, bom, eol: detectEol(text) };
}

export function encodeText(text: string, encoding: Encoding, bom: boolean): Buffer {
  const body = encode(text, encoding);
  // A BOM only makes sense for UTF-8; win1251 has none.
  return bom && encoding === "utf8"
    ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body])
    : body;
}

/**
 * Text equality used to decide whether two sides are in sync: line endings
 * are ignored, so a file saved with LF by an agent in a Linux container is
 * not treated as different from its CRLF original.
 */
export function sameText(a: string, b: string): boolean {
  return a === b || a.replace(/\r\n/g, "\n") === b.replace(/\r\n/g, "\n");
}

export function writeBytes(absPath: string, data: Uint8Array): void {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, data);
}

/** Delete a file and then any directories it leaves empty, up to `stopAt`. */
export function removeFile(absPath: string, stopAt: string): void {
  fs.rmSync(absPath, { force: true });
  let dir = path.dirname(absPath);
  const root = path.resolve(stopAt);
  while (path.resolve(dir) !== root && path.resolve(dir).startsWith(root)) {
    try {
      fs.rmdirSync(dir); // only succeeds when empty
    } catch {
      break;
    }
    dir = path.dirname(dir);
  }
}

/**
 * Recursively list files under `root` as POSIX relative paths. `skipDir`
 * receives the relative path of each directory and can prune it. Symlinks
 * are never followed.
 */
export function walkFiles(root: string, skipDir: (relDir: string) => boolean): string[] {
  const out: string[] = [];
  if (!fs.existsSync(root)) {
    return out;
  }
  const stack: string[] = [""];
  while (stack.length > 0) {
    const relDir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, ...relDir.split("/").filter(Boolean)), {
        withFileTypes: true,
      });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!skipDir(rel)) {
          stack.push(rel);
        }
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  }
  return out.sort();
}

/** Errors Windows returns while another program has a file open for a moment. */
const TRANSIENT_LOCK = new Set(["EPERM", "EACCES", "EBUSY"]);

/** Block the thread for a few milliseconds (a sync retry loop has no other way). */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Write a file atomically: to `<file>.tmp`, then rename over the file — a
 * crash never leaves it half written. On Windows the rename fails while an
 * antivirus, the search indexer or an editor has the target open for a
 * moment; that is retried for about a second before the error is passed on.
 */
export function writeFileAtomic(file: string, data: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, data);
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (!TRANSIENT_LOCK.has(code) || attempt >= 12) {
        throw e;
      }
      pause(Math.min(200, 20 * attempt));
    }
  }
}
