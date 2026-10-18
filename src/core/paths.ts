import * as path from "node:path";
import type { Transformer } from "./transformer.js";

/** Which of the two trees a path belongs to. */
export type Side = "project" | "sandbox";

export const otherSide = (side: Side): Side => (side === "project" ? "sandbox" : "project");

/** OS path -> POSIX relative path used everywhere inside anonymus. */
export function toPosixRelative(root: string, absPath: string): string {
  return path.relative(root, absPath).split(path.sep).join("/");
}

/** POSIX relative path -> absolute OS path under `root`. */
export function toAbsolute(root: string, relPosix: string): string {
  return path.join(root, ...relPosix.split("/"));
}

/**
 * Maps file paths between the two trees. The CANONICAL key of a file is its
 * real relative path in the main project; the sandbox path is the same path
 * with real names replaced by placeholders, so
 * `BIGcorpProject_cpu01/main.c` <-> `MyProject_cpu01/main.c`.
 */
export class PathMapper {
  constructor(private readonly transformer: Transformer) {}

  toSandbox(canonicalPath: string): string {
    return this.transformer.anonymizePath(canonicalPath);
  }

  toCanonical(sandboxPath: string): string {
    return this.transformer.deanonymizePath(sandboxPath);
  }

  /** Path of the file on the given side. */
  sidePath(side: Side, canonicalPath: string): string {
    return side === "project" ? canonicalPath : this.toSandbox(canonicalPath);
  }

  /**
   * A project path is safe to sync only if anonymizing then deanonymizing it
   * gives the same path back; otherwise two files could swap identities.
   */
  projectPathProblem(canonicalPath: string): string | undefined {
    const back = this.toCanonical(this.toSandbox(canonicalPath));
    return back === canonicalPath
      ? undefined
      : `путь не восстанавливается после анонимизации (${canonicalPath} → ${this.toSandbox(canonicalPath)} → ${back})`;
  }

  /**
   * A sandbox path must be in "placeholder form": if it still contains a real
   * name, it does not map back to itself and would be renamed on the next sync.
   */
  sandboxPathProblem(sandboxPath: string): string | undefined {
    const canonical = this.toCanonical(sandboxPath);
    const again = this.toSandbox(canonical);
    return again === sandboxPath
      ? undefined
      : `путь в песочнице содержит реальное имя (${sandboxPath} ожидался бы как ${again})`;
  }
}
