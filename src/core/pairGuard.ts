import * as fs from "node:fs";
import * as path from "node:path";
import { isInside } from "../config/loader.js";
import { readHeadBranch, readWorktreeLink } from "./git.js";
import type { Side } from "./paths.js";
import type { SandboxEntry } from "./registry.js";

/**
 * Why a pair must not sync right now. Every check exists so that a sandbox
 * can never start syncing with a folder that is not ITS worktree: a sandbox
 * synced against the wrong tree would receive (or push) a whole other branch,
 * or have everything deleted.
 */
export type ProblemCode =
  | "worktree-missing" // the worktree folder is gone (git worktree remove, deleted by hand)
  | "not-worktree" // the folder is there, but it is not a worktree of this repository
  | "foreign-worktree" // a worktree, but not the one anonymus created (re-created / replaced)
  | "wrong-branch" // another branch was checked out inside the worktree
  | "sandbox-missing" // the sandbox folder is gone, though it was synced before
  | "mass-delete" // too many files vanished on one side at once (stopped by the syncer)
  | "io-error"; // the folders could not be read at all (scan failed)

export interface PairProblem {
  code: ProblemCode;
  message: string;
  /** For wrong-branch: what is checked out now (null = detached HEAD). */
  actualBranch?: string | null;
  /** For mass-delete: where the files vanished and how many. */
  side?: Side;
  count?: number;
}

/** Name of the ownership mark in the worktree's own git folder. */
const MARK_FILE = "anonymus.json";

interface WorktreeMark {
  id: string;
  pair: string;
  branch: string;
}

/**
 * Write the ownership mark into `<repo>/.git/worktrees/<x>/` — the git folder
 * of that one worktree. Git deletes that folder together with the worktree
 * (`git worktree remove` / `prune`), so a worktree created again by hand at
 * the same path comes without the mark and is never taken for ours.
 */
export function writeMark(gitDir: string, entry: Pick<SandboxEntry, "worktreeId" | "name" | "branch">): void {
  const mark: WorktreeMark = { id: entry.worktreeId, pair: entry.name, branch: entry.branch };
  fs.writeFileSync(path.join(gitDir, MARK_FILE), JSON.stringify(mark, null, 2), "utf8");
}

function readMark(gitDir: string): WorktreeMark | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(gitDir, MARK_FILE), "utf8")) as WorktreeMark;
  } catch {
    return null;
  }
}

/** Git folder of the pair's worktree, if `.git` there points into this repository. */
export function pairGitDir(entry: SandboxEntry, commonGitDir: string): string | null {
  const link = readWorktreeLink(entry.worktree);
  if (link.kind !== "worktree" || !isInside(link.gitDir, path.join(commonGitDir, "worktrees"))) {
    return null;
  }
  return fs.existsSync(link.gitDir) ? link.gitDir : null;
}

/**
 * Is the pair safe to sync? Only reads a few small files (no git process),
 * so it runs before every file the syncer applies and once a second.
 */
export function checkPair(
  entry: SandboxEntry,
  commonGitDir: string,
  options: { hasHistory: boolean }
): PairProblem | null {
  const wt = entry.worktree;
  if (!fs.existsSync(wt)) {
    return { code: "worktree-missing", message: `папки worktree ${wt} нет — его удалили (через git или вручную)` };
  }
  const link = readWorktreeLink(wt);
  if (link.kind === "missing") {
    return { code: "not-worktree", message: `${wt} — не git worktree (нет файла .git)` };
  }
  if (link.kind === "repository") {
    return { code: "not-worktree", message: `${wt} — отдельный git-репозиторий, а не worktree этого проекта` };
  }
  if (!isInside(link.gitDir, path.join(commonGitDir, "worktrees"))) {
    return { code: "not-worktree", message: `${wt} — worktree другого репозитория` };
  }
  if (!fs.existsSync(link.gitDir)) {
    return { code: "not-worktree", message: `git больше не знает worktree ${wt} (удалён через git worktree prune)` };
  }
  const mark = readMark(link.gitDir);
  if (!mark || mark.id !== entry.worktreeId) {
    return {
      code: "foreign-worktree",
      message: `${wt} — не тот worktree, что создал anonymus (пересоздан или подменён)`,
    };
  }
  const head = readHeadBranch(link.gitDir);
  // undefined: git is rewriting HEAD this very moment — judged on the next check.
  if (head !== undefined && head !== entry.branch) {
    return {
      code: "wrong-branch",
      message: `в worktree ${path.basename(wt)} выбрана ${head ? `ветка ${head}` : "отделённая HEAD"}, а подпесочница привязана к ${entry.branch}`,
      actualBranch: head,
    };
  }
  if (options.hasHistory && !fs.existsSync(entry.sandbox)) {
    return { code: "sandbox-missing", message: `папки песочницы ${entry.sandbox} нет` };
  }
  return null;
}

/**
 * Where the worktree with this pair's mark is now — after `git worktree move`
 * the mark travels with it. Null if no worktree of the repository carries it.
 */
export function findMarkedWorktree(commonGitDir: string, worktreeId: string): string | null {
  const dir = path.join(commonGitDir, "worktrees");
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    const gitDir = path.join(dir, name);
    if (readMark(gitDir)?.id !== worktreeId) {
      continue;
    }
    try {
      // `gitdir` in a worktree's git folder: the path of `<worktree>/.git`.
      const dotGit = fs.readFileSync(path.join(gitDir, "gitdir"), "utf8").trim();
      const wt = path.dirname(path.resolve(dotGit));
      return fs.existsSync(wt) ? wt : null;
    } catch {
      return null;
    }
  }
  return null;
}
