import { execFileSync } from "node:child_process";
import { SERVICE_DIR } from "../config/schema.js";

/** A git command failed; `message` is ready to show to the user. */
export class GitError extends Error {
  constructor(message: string, readonly output = "") {
    super(message);
    this.name = "GitError";
  }
}

/** Paths anonymus itself writes in the project; they never make it "dirty". */
const OWN_PATHS = [`${SERVICE_DIR}/`, "anonymus.yaml", ".anonymus.yaml"];

/**
 * Thin wrapper over the git CLI for the project folder. Only what the
 * sub-sandbox workflow needs: branches, checkout and per-branch stashes.
 */
export class Git {
  constructor(readonly cwd: string) {}

  private run(args: string[]): string {
    return this.exec(args).toString("utf8").trimEnd();
  }

  /** Run git and return raw stdout (file contents are binary-safe). */
  private exec(args: string[]): Buffer {
    try {
      return execFileSync("git", args, {
        cwd: this.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        maxBuffer: 256 * 1024 * 1024,
      });
    } catch (e) {
      const err = e as { stderr?: Buffer; stdout?: Buffer; code?: string; message: string };
      if (err.code === "ENOENT") {
        throw new GitError("git не найден в PATH");
      }
      const out = `${err.stderr?.toString("utf8") ?? ""}${err.stdout?.toString("utf8") ?? ""}`.trim();
      throw new GitError(`git ${args[0]}: ${out.split("\n")[0] || err.message}`, out);
    }
  }

  isRepo(): boolean {
    try {
      return this.run(["rev-parse", "--is-inside-work-tree"]) === "true";
    } catch {
      return false;
    }
  }

  /** Current branch name, or null for a detached HEAD / no commits yet. */
  currentBranch(): string | null {
    try {
      const name = this.run(["symbolic-ref", "--quiet", "--short", "HEAD"]);
      this.run(["rev-parse", "--verify", "--quiet", "HEAD"]); // has a commit
      return name || null;
    } catch {
      return null;
    }
  }

  branchExists(name: string): boolean {
    try {
      this.run(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
      return true;
    } catch {
      return false;
    }
  }

  /** Is `name` acceptable as a new branch name? */
  isValidBranchName(name: string): boolean {
    try {
      this.run(["check-ref-format", "--branch", name]);
      return true;
    } catch {
      return false;
    }
  }

  /** Create a branch at `from` (HEAD by default) without switching to it. */
  createBranch(name: string, from?: string): void {
    this.run(from ? ["branch", name, from] : ["branch", name]);
  }

  /** Commit id a ref points to. */
  commitOf(ref: string): string {
    return this.run(["rev-parse", "--verify", `${ref}^{commit}`]);
  }

  /** Common ancestor of two refs. */
  mergeBase(a: string, b: string): string {
    return this.run(["merge-base", a, b]);
  }

  /** All file paths (POSIX) stored in a commit. */
  listFiles(commit: string): string[] {
    // -z: raw NUL-separated paths, no quoting of non-ASCII names.
    return this.exec(["ls-tree", "-r", "-z", "--name-only", commit])
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
  }

  /** Raw bytes of a file in a commit. */
  readFile(commit: string, filePath: string): Buffer {
    return this.exec(["cat-file", "blob", `${commit}:${filePath}`]);
  }

  /**
   * Commit all uncommitted work (tracked and new files) except anonymus' own
   * files. Returns false when there was nothing to commit.
   */
  commitAll(message: string): boolean {
    if (!this.isDirty()) {
      return false;
    }
    this.run(["add", "--all", "--", ".", ...this.ownExcludes()]);
    this.run(["commit", "--quiet", "--message", message]);
    return true;
  }

  /** Pathspecs that keep anonymus' own config / service folder out of git operations. */
  private ownExcludes(): string[] {
    return OWN_PATHS.map((p) => `:(exclude)${p.replace(/\/$/, "")}`);
  }

  checkout(name: string): void {
    this.run(["checkout", "--quiet", name]);
  }

  /** Uncommitted changes (tracked or untracked), ignoring anonymus' own files. */
  isDirty(): boolean {
    const lines = this.run(["status", "--porcelain", "--untracked-files=all"]).split("\n").filter(Boolean);
    return lines.some((line) => {
      const file = line.slice(3).replace(/^"|"$/g, "");
      return !OWN_PATHS.some((own) => file === own || file.startsWith(own));
    });
  }

  /**
   * Stash everything uncommitted (including untracked files) under `label`,
   * except anonymus' own config and service folder — they must stay in place
   * while branches are switched.
   */
  stashPush(label: string): void {
    this.run(["stash", "push", "--include-untracked", "--message", label, "--", ".", ...this.ownExcludes()]);
  }

  /** `stash@{n}` of the newest stash whose message contains `label`, if any. */
  findStash(label: string): string | null {
    const list = this.run(["stash", "list", "--format=%gd%x09%s"]);
    for (const line of list.split("\n")) {
      const [ref, subject] = line.split("\t");
      if (ref && subject?.includes(label)) {
        return ref;
      }
    }
    return null;
  }

  stashPop(ref: string): void {
    this.run(["stash", "pop", "--quiet", ref]);
  }
}
