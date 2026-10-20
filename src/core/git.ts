import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { SERVICE_DIR } from "../config/schema.js";

/** A git command failed; `message` is ready to show to the user. */
export class GitError extends Error {
  constructor(message: string, readonly output = "") {
    super(message);
    this.name = "GitError";
  }
}

/**
 * Branch named in a HEAD file, read directly — cheap enough to poll every
 * second, unlike spawning git. Null for a detached HEAD; undefined when the
 * file cannot be read (git is rewriting it right now).
 */
export function readHeadBranch(gitDir: string): string | null | undefined {
  let head: string;
  try {
    head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
  } catch {
    return undefined;
  }
  const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
  return m ? m[1] : null;
}

/** A git command (checkout, merge, stash…) holds the index right now. */
export function gitBusy(gitDir: string): boolean {
  return fs.existsSync(path.join(gitDir, "index.lock"));
}

/** Paths anonymus itself writes in the main project; they never make it "dirty". */
const OWN_PATHS = [`${SERVICE_DIR}/`, "anonymus.yaml", ".anonymus.yaml"];

/**
 * Thin wrapper over the git CLI for one folder (the main project or one of
 * its worktrees). Only what the sub-sandbox workflow needs: branches,
 * worktrees, commits and merges.
 */
export class Git {
  constructor(readonly cwd: string) {}

  private run(args: string[], env?: NodeJS.ProcessEnv): string {
    return this.exec(args, env).toString("utf8").trimEnd();
  }

  /** Run git and return raw stdout (file contents are binary-safe). */
  private exec(args: string[], env?: NodeJS.ProcessEnv): Buffer {
    try {
      return execFileSync("git", args, {
        cwd: this.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        maxBuffer: 256 * 1024 * 1024,
        env: env ? { ...process.env, ...env } : undefined,
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

  /**
   * Run git without blocking the event loop — for the slow commands
   * (checking out a worktree, cloning submodules) so the UI keeps drawing.
   */
  private runAsync(args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        "git",
        args,
        {
          cwd: this.cwd,
          windowsHide: true,
          maxBuffer: 256 * 1024 * 1024,
          env: env ? { ...process.env, ...env } : undefined,
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve(stdout.trimEnd());
          } else if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            reject(new GitError("git не найден в PATH"));
          } else {
            const out = `${stderr}${stdout}`.trim();
            reject(new GitError(`git ${args[0]}: ${out.split("\n")[0] || error.message}`, out));
          }
        }
      ).stdin?.end();
    });
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

  /** Absolute path of the repository's .git folder (also for worktrees). */
  gitDir(): string {
    return this.run(["rev-parse", "--absolute-git-dir"]);
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

  /** Delete a branch (used to undo a branch created for a pair that failed to set up). */
  deleteBranch(name: string): void {
    this.run(["branch", "--quiet", "-D", name]);
  }

  /** Local branch names. */
  listBranches(): string[] {
    return this.run(["for-each-ref", "--format=%(refname:short)", "refs/heads/"]).split("\n").filter(Boolean);
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
    this.run(["add", "--all", ...this.ownExcludes()]);
    this.run(["commit", "--quiet", "--message", message]);
    return true;
  }

  /**
   * Pathspec arguments that keep anonymus' own config / service folder out of
   * `add`. Paths already in .gitignore are left out: git skips them
   * anyway and refuses ("paths are ignored") when they are named explicitly.
   * Returns [] when nothing needs excluding — then no pathspec is passed at all.
   */
  private ownExcludes(): string[] {
    const excludes = OWN_PATHS.map((p) => p.replace(/\/$/, "")).filter((p) => !this.isIgnored(p));
    return excludes.length ? ["--", ".", ...excludes.map((p) => `:(exclude)${p}`)] : [];
  }

  /** Is `p` ignored by .gitignore (or info/exclude)? */
  private isIgnored(p: string): boolean {
    try {
      this.run(["check-ignore", "--quiet", p]);
      return true;
    } catch {
      return false; // exit code 1: not ignored
    }
  }

  checkout(name: string): void {
    this.run(["checkout", "--quiet", name]);
  }

  /** Uncommitted changes (tracked or untracked), ignoring anonymus' own files. */
  isDirty(): boolean {
    return this.changedFiles().length > 0;
  }

  /** Paths (POSIX, relative to this folder) with uncommitted changes, own files excluded. */
  changedFiles(): string[] {
    // -z: NUL-separated, no quoting of non-ASCII names; renames are not reported
    // without --find-renames, so every record is "XY path".
    const records = this.exec(["status", "--porcelain", "-z", "--untracked-files=all"])
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    return records
      .map((r) => r.slice(3))
      .filter((file) => !OWN_PATHS.some((own) => file === own || file.startsWith(own)));
  }

  // --- worktrees -----------------------------------------------------------

  /** The repository's shared .git folder (the same for all its worktrees). */
  commonGitDir(): string {
    return path.resolve(this.cwd, this.run(["rev-parse", "--git-common-dir"]));
  }

  /** New worktree at `dir` with `branch` checked out (the branch must exist). */
  async worktreeAdd(dir: string, branch: string): Promise<void> {
    await this.runAsync(["worktree", "add", "--quiet", dir, branch]);
  }

  /** Remove a worktree; `force` also discards its uncommitted changes. */
  worktreeRemove(dir: string, force = false): void {
    this.run(["worktree", "remove", ...(force ? ["--force"] : []), dir]);
  }

  /** Does this checkout declare submodules (.gitmodules)? */
  hasSubmodules(): boolean {
    return fs.existsSync(path.join(this.cwd, ".gitmodules"));
  }

  /**
   * Check out the submodules (recursively): `git worktree add` leaves their
   * folders empty. They are cloned from the URLs in .gitmodules; git must not
   * stop to ask for a password in a terminal nobody sees.
   */
  async submoduleUpdate(): Promise<void> {
    await this.runAsync(["submodule", "update", "--init", "--recursive"], { GIT_TERMINAL_PROMPT: "0" });
  }

  /** Forget worktrees whose folders are gone. */
  worktreePrune(): void {
    this.run(["worktree", "prune"]);
  }

  /** All worktrees of the repository (the main folder first). */
  worktreeList(): { path: string; branch: string | null; prunable: boolean }[] {
    const out: { path: string; branch: string | null; prunable: boolean }[] = [];
    for (const block of this.run(["worktree", "list", "--porcelain"]).split(/\n\n+/)) {
      const lines = block.split("\n");
      const wt = lines.find((l) => l.startsWith("worktree "));
      if (!wt) continue;
      const branch = lines.find((l) => l.startsWith("branch "))?.slice("branch refs/heads/".length) ?? null;
      out.push({ path: path.resolve(wt.slice("worktree ".length)), branch, prunable: lines.some((l) => l.startsWith("prunable")) });
    }
    return out;
  }

  // --- merging -------------------------------------------------------------

  /** A merge was started and is not committed or aborted yet. */
  mergeInProgress(): boolean {
    try {
      this.run(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * `git merge --no-ff` of `branch` into the checked-out branch. On conflicts
   * the merge stays in progress and the conflicted paths are returned.
   */
  merge(branch: string, message: string): { ok: true } | { ok: false; conflicts: string[] } {
    try {
      this.run(["merge", "--no-ff", "--no-edit", "--message", message, branch]);
      return { ok: true };
    } catch (e) {
      const conflicts = this.mergeInProgress() ? this.conflictedFiles() : [];
      if (conflicts.length === 0) {
        throw e; // refused before merging (e.g. local changes would be overwritten)
      }
      return { ok: false, conflicts };
    }
  }

  /** Paths with unresolved merge conflicts. */
  conflictedFiles(): string[] {
    return this.exec(["diff", "--name-only", "-z", "--diff-filter=U"]).toString("utf8").split("\0").filter(Boolean);
  }

  /** Finish a merge in progress: stage everything (own files excluded) and commit. */
  commitMerge(): void {
    this.run(["add", "--all", ...this.ownExcludes()]);
    this.run(["commit", "--quiet", "--no-edit"]);
  }

  mergeAbort(): void {
    this.run(["merge", "--abort"]);
  }
}

/** Contents of the `.git` file of a worktree: where its git folder is. */
export type WorktreeLink =
  | { kind: "missing" } // no .git at all
  | { kind: "repository" } // .git is a folder: a separate clone / main repo, not a worktree
  | { kind: "worktree"; gitDir: string };

/**
 * Read `<dir>/.git` without running git (cheap enough to poll every second).
 * A linked worktree has a FILE `gitdir: <repo>/.git/worktrees/<id>`.
 */
export function readWorktreeLink(dir: string): WorktreeLink {
  const dotGit = path.join(dir, ".git");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dotGit);
  } catch {
    return { kind: "missing" };
  }
  if (stat.isDirectory()) {
    return { kind: "repository" };
  }
  try {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, "utf8"));
    return m ? { kind: "worktree", gitDir: path.resolve(dir, m[1]) } : { kind: "missing" };
  } catch {
    return { kind: "missing" };
  }
}
