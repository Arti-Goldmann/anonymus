import * as fs from "node:fs";
import * as path from "node:path";
import { isInside } from "../config/loader.js";
import { SERVICE_DIR, type AnonymusConfig } from "../config/schema.js";
import { SyncEngine } from "./engine.js";
import { Git, GitError } from "./git.js";
import { Registry, type SandboxEntry } from "./registry.js";
import { Transformer } from "./transformer.js";

/** Progress callback for multi-step operations (shown in the UI). */
export type StepReporter = (message: string) => void;

/** The project is on another branch than the active sub-sandbox. */
export interface BranchProblem {
  /** Branch of the active sub-sandbox. */
  expected: string;
  /** Branch checked out in the project; null for a detached HEAD. */
  actual: string | null;
  /** Sub-sandbox of `actual`, if there is one. */
  target: string | null;
}

export interface StartupNotice {
  kind: "info" | "warning";
  message: string;
}

/**
 * The project plus all its sub-sandboxes. Each sub-sandbox is tied to one git
 * branch of the project; exactly one is active and synced. Switching stashes
 * the project's uncommitted work for the current branch, checks out the target
 * branch and restores that branch's stash.
 *
 * The caller stops the running Syncer before switching / creating and starts a
 * new one (for `engineFor(active)`) afterwards.
 */
export class Workspace {
  readonly git: Git | null;
  readonly registry: Registry;
  private readonly transformer: Transformer;
  /** The project's branch is not linked to the active sub-sandbox. */
  branchMismatch = false;

  constructor(readonly config: AnonymusConfig) {
    const git = new Git(config.projectRoot);
    this.git = git.isRepo() ? git : null;
    this.transformer = new Transformer(config.replacements);
    this.registry = new Registry(config, this.git?.currentBranch() ?? null);
  }

  get gitEnabled(): boolean {
    return this.git !== null;
  }

  get active(): SandboxEntry {
    return this.registry.active;
  }

  /** A sync engine for one sub-sandbox (the active one by default). */
  engineFor(entry: SandboxEntry = this.registry.active): SyncEngine {
    return new SyncEngine({ ...this.config, profile: this.registry.profileOf(entry) });
  }

  /**
   * Make the active sub-sandbox match the branch actually checked out in the
   * project (someone may have switched branches by hand).
   */
  reconcileWithGit(): StartupNotice[] {
    const notices: StartupNotice[] = [];
    this.branchMismatch = false;
    const branch = this.git?.currentBranch() ?? null;
    if (!this.git || !branch) {
      this.registry.save();
      return notices;
    }
    const active = this.registry.active;
    if (active.branch === null) {
      active.branch = branch;
    } else if (active.branch !== branch) {
      const match = this.sandboxOfBranch(branch);
      if (match) {
        this.registry.setActive(match.name);
        notices.push({
          kind: "info",
          message: `в проекте ветка ${branch} — активна её подпесочница «${match.name}»`,
        });
      } else {
        this.branchMismatch = true;
        notices.push({
          kind: "warning",
          message:
            `в проекте ветка ${branch}, а подпесочница «${active.name}» привязана к ${active.branch} — ` +
            `синхронизация не запущена, пока не выбрано, что делать`,
        });
      }
    }
    this.registry.save();
    return notices;
  }

  /** The sub-sandbox tied to a branch, if there is one. */
  sandboxOfBranch(branch: string | null): SandboxEntry | undefined {
    return branch === null ? undefined : this.registry.list().find((s) => s.branch === branch);
  }

  /**
   * The project's checked-out branch is not the active sub-sandbox's one.
   * Syncing now would copy the other branch into this sub-sandbox, so the
   * caller must not scan until the user picks what to do. Null when fine
   * (or when there is no git / no branch to compare).
   */
  branchProblem(): BranchProblem | null {
    const expected = this.registry.active.branch;
    if (!this.git || !expected) {
      return null;
    }
    const actual = this.git.currentBranch();
    if (actual === expected) {
      return null;
    }
    const target = this.sandboxOfBranch(actual);
    return { expected, actual, target: target?.name ?? null };
  }

  /** Why the checked-out branch cannot get its own sub-sandbox, or null if it can. */
  validateAdopt(branch: string): string | null {
    if (this.registry.get(branch) || this.sandboxOfBranch(branch)) {
      return `подпесочница для ветки ${branch} уже есть`;
    }
    const folder = this.folderFor(branch);
    if (isInside(folder, this.config.projectRoot)) {
      return `папка ${folder} оказалась бы внутри проекта — проверьте sandboxes_dir`;
    }
    if (fs.existsSync(folder) && fs.readdirSync(folder).length > 0) {
      return `папка ${folder} уже существует и не пуста`;
    }
    return null;
  }

  /**
   * A new sub-sandbox for the branch already checked out in the project (no
   * new branch is created) and make it active. It starts empty: the next scan
   * fills it from the project.
   */
  adoptCurrentBranch(step: StepReporter = () => {}): string[] {
    const branch = this.git?.currentBranch() ?? null;
    if (!branch) {
      throw new Error("в проекте не выбрана ветка (отделённый HEAD) — подпесочницу привязать не к чему");
    }
    const problem = this.validateAdopt(branch);
    if (problem) {
      throw new Error(problem);
    }
    const folder = this.folderFor(branch);
    step(`создаю папку ${folder}`);
    fs.mkdirSync(folder, { recursive: true });
    this.registry.add({ name: branch, absPath: folder, branch });
    this.registry.setActive(branch);
    this.branchMismatch = false;
    this.registry.save();
    return [];
  }

  /**
   * Undo a `git checkout` made outside anonymus: put the active sub-sandbox's
   * branch back. Uncommitted changes travel with the checkout as git allows;
   * if git refuses, the error says why and nothing changes.
   */
  checkoutActiveBranch(step: StepReporter = () => {}): string[] {
    const branch = this.registry.active.branch;
    if (!this.git || !branch) {
      throw new Error("у активной подпесочницы нет git-ветки");
    }
    if (this.git.currentBranch() !== branch) {
      step(`git checkout ${branch}`);
      this.git.checkout(branch);
    }
    this.branchMismatch = false;
    return [];
  }

  /** Folder a new sub-sandbox would get (placeholder names only). */
  folderFor(name: string): string {
    const safe = name.replace(/[\\/:*?"<>|\s]+/g, "-");
    return path.join(this.config.sandboxesDir, this.transformer.anonymizePath(safe));
  }

  /** Why `name` cannot be used for a new sub-sandbox, or null if it can. */
  validateNewName(name: string): string | null {
    const n = name.trim();
    if (!this.git) {
      return "проект не является git-репозиторием — подпесочницы по веткам недоступны";
    }
    if (!n) {
      return "введите имя";
    }
    if (!this.git.isValidBranchName(n)) {
      return `«${n}» не подходит как имя git-ветки`;
    }
    if (this.git.branchExists(n)) {
      return `ветка ${n} уже существует`;
    }
    if (this.registry.get(n)) {
      return `подпесочница «${n}» уже есть`;
    }
    const folder = this.folderFor(n);
    if (isInside(folder, this.config.projectRoot)) {
      return `папка ${folder} оказалась бы внутри проекта — проверьте sandboxes_dir`;
    }
    if (fs.existsSync(folder) && fs.readdirSync(folder).length > 0) {
      return `папка ${folder} уже существует и не пуста`;
    }
    return null;
  }

  /**
   * Switch the project to `name`'s branch and make it the active sub-sandbox.
   * Returns warnings that need the user's attention (nothing is lost).
   */
  switchTo(name: string, step: StepReporter = () => {}): string[] {
    const target = this.registry.get(name);
    if (!target) {
      throw new Error(`нет подпесочницы «${name}»`);
    }
    const current = this.registry.active;
    const warnings: string[] = [];

    if (this.git && target.branch && this.git.currentBranch() !== target.branch) {
      if (this.git.isDirty()) {
        const label = `anonymus:${current.name}:${Date.now()}`;
        step(`незакоммиченные изменения ветки ${current.branch ?? "?"} → git stash`);
        try {
          this.git.stashPush(label);
        } catch (e) {
          // git may have saved the stash and then failed before cleaning the
          // working tree: the changes are still in place, so that stash is a
          // redundant copy — remove it rather than leave it orphaned.
          const ref = this.git.findStash(label);
          if (ref && this.git.isDirty()) {
            this.git.stashDrop(ref);
          }
          throw e;
        }
        current.stash = label;
        this.registry.save();
      }
      step(`git checkout ${target.branch}`);
      try {
        this.git.checkout(target.branch);
      } catch (e) {
        // Put the stashed work back so the project looks exactly as before.
        if (current.stash) {
          const ref = this.git.findStash(current.stash);
          if (ref) {
            this.git.stashPop(ref);
          }
          current.stash = null;
          this.registry.save();
        }
        throw e;
      }
    }

    if (this.git && target.stash) {
      step(`возвращаю незакоммиченные изменения ветки ${target.branch}`);
      const ref = this.git.findStash(target.stash);
      if (!ref) {
        warnings.push(`stash ${target.stash} не найден — вероятно, его уже применили вручную`);
        target.stash = null;
      } else {
        try {
          this.git.stashPop(ref);
          target.stash = null;
        } catch (e) {
          warnings.push(
            `stash ${target.stash} применился с конфликтами — разрешите их в git; ` +
              `сам stash сохранён (${(e as GitError).message})`
          );
        }
      }
    }

    this.registry.setActive(target.name);
    this.branchMismatch = false;
    this.registry.save();
    return warnings;
  }

  /** Branches a new sub-sandbox can be created from: the current one first. */
  baseBranchChoices(): string[] {
    const current = this.git?.currentBranch();
    const branches = this.registry.list().map((s) => s.branch).filter((b): b is string => !!b);
    return [...new Set([...(current ? [current] : []), ...branches])];
  }

  /**
   * New branch from `from` (the current branch by default) plus a new
   * sub-sandbox for it. With `switchTo` (default) the project switches to the
   * new branch; without it the sub-sandbox is filled straight from the branch's
   * commit and the project stays where it is — handy to set up several agent
   * branches off one parent in a row.
   */
  create(
    name: string,
    options: { from?: string; switchTo?: boolean } = {},
    step: StepReporter = () => {}
  ): { entry: SandboxEntry; warnings: string[]; filled: number } {
    const n = name.trim();
    const problem = this.validateNewName(n);
    if (problem) {
      throw new Error(problem);
    }
    const git = this.git!;
    const from = options.from ?? git.currentBranch() ?? "HEAD";
    if (from !== "HEAD" && !git.branchExists(from)) {
      throw new Error(`нет ветки ${from}`);
    }
    const commit = git.commitOf(from);
    step(`создаю ветку ${n} от ${from}`);
    git.createBranch(n, from);
    const folder = this.folderFor(n);
    step(`создаю папку ${folder}`);
    fs.mkdirSync(folder, { recursive: true });
    const entry = this.registry.add({
      name: n,
      absPath: folder,
      branch: n,
      base: from === "HEAD" ? null : { branch: from, commit },
    });
    this.registry.save();

    if (options.switchTo === false) {
      step(`заполняю подпесочницу из ${from} (без переключения проекта)`);
      return { entry, warnings: [], filled: this.fillFromCommit(entry, commit) };
    }
    return { entry, warnings: this.switchTo(n, step), filled: 0 };
  }

  /**
   * Write the files of a commit into a sub-sandbox, anonymized, without
   * touching the project. No sync state is recorded: when the sub-sandbox
   * becomes active, the scan finds both sides equal and records them then.
   */
  private fillFromCommit(entry: SandboxEntry, commit: string): number {
    const engine = this.engineFor(entry);
    let count = 0;
    for (const file of this.git!.listFiles(commit)) {
      if (!engine.filter.isSynced(file) || engine.mapper.projectPathProblem(file)) {
        continue;
      }
      engine.writeTransformed("project", file, this.git!.readFile(commit, file));
      count++;
    }
    return count;
  }

  /** Commit message suggested for the active sub-sandbox's work. */
  defaultCommitMessage(): string {
    const active = this.registry.active;
    return active.mergeSources?.length
      ? `Слияние: ${active.mergeSources.join(", ")}`
      : `Изменения подпесочницы ${active.name}`;
  }

  /**
   * Commit everything uncommitted on the active branch (anonymus' own files
   * excluded). Returns false when there was nothing to commit.
   */
  commitActive(message = this.defaultCommitMessage()): boolean {
    if (!this.git) {
      throw new Error("проект не является git-репозиторием");
    }
    const committed = this.git.commitAll(message);
    if (committed && this.registry.active.mergeSources) {
      this.registry.active.mergeSources = null;
      this.registry.save();
    }
    return committed;
  }

  /**
   * Remove a sub-sandbox: its folder and sync state go to the trash, the git
   * branch stays. The active one cannot be removed.
   */
  remove(
    name: string,
    step: StepReporter = () => {},
    options: { dropStash?: boolean } = {}
  ): { trashDir: string; warnings: string[]; stashDropped: boolean } {
    const entry = this.registry.get(name);
    if (!entry) {
      throw new Error(`нет подпесочницы «${name}»`);
    }
    if (entry.name === this.registry.active.name) {
      throw new Error("активную подпесочницу удалить нельзя — сначала переключитесь на другую");
    }
    const warnings: string[] = [];
    const stamp = new Date().toISOString().replace(/T/, "_").replace(/:/g, "-").replace(/\..+$/, "");
    const trashDir = path.join(this.config.projectRoot, SERVICE_DIR, "trash", stamp, "sandboxes");
    fs.mkdirSync(trashDir, { recursive: true });

    const folder = this.registry.absPath(entry);
    if (fs.existsSync(folder)) {
      step(`переношу ${folder} в корзину`);
      moveDir(folder, uniquePath(path.join(trashDir, path.basename(folder))));
    }
    const stateDir = path.join(this.config.projectRoot, SERVICE_DIR, "profiles", ...entry.name.split("/"));
    if (fs.existsSync(stateDir)) {
      moveDir(stateDir, uniquePath(path.join(trashDir, `${path.basename(folder)}.state`)));
    }
    let stashDropped = false;
    if (entry.stash) {
      const ref = this.git?.findStash(entry.stash) ?? null;
      if (!ref) {
        // Already gone (applied or dropped by hand): nothing to keep or remove.
      } else if (options.dropStash) {
        step(`удаляю stash ветки ${entry.branch}`);
        this.git!.stashDrop(ref);
        stashDropped = true;
      } else {
        warnings.push(`у ветки ${entry.branch} остался stash «${entry.stash}» — он в git stash list`);
      }
    }
    this.registry.remove(entry.name);
    this.registry.save();
    return { trashDir, warnings, stashDropped };
  }

  /** Does this sub-sandbox have stashed uncommitted work that still exists in git? */
  hasStash(name: string): boolean {
    const entry = this.registry.get(name);
    return !!(entry?.stash && this.git?.findStash(entry.stash));
  }
}

function uniquePath(p: string): string {
  let candidate = p;
  for (let i = 1; fs.existsSync(candidate); i++) {
    candidate = `${p}.${i}`;
  }
  return candidate;
}

/** Move a folder; across drives fall back to copy + delete. */
function moveDir(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EXDEV") {
      fs.cpSync(from, to, { recursive: true });
      fs.rmSync(from, { recursive: true, force: true });
    } else if (code === "EBUSY" || code === "EPERM") {
      throw new Error(`папка ${from} занята (открыта в редакторе или контейнере) — закройте и повторите`);
    } else {
      throw e;
    }
  }
}
