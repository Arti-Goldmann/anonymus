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
      const match = this.registry.list().find((s) => s.branch === branch);
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
            `в проекте ветка ${branch}, а подпесочница «${active.name}» привязана к ${active.branch}. ` +
            `Переключитесь (b) или создайте подпесочницу для этой ветки.`,
        });
      }
    }
    this.registry.save();
    return notices;
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
        this.git.stashPush(label);
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

  /** New branch from HEAD + new sub-sandbox for it, then switch to it. */
  create(name: string, step: StepReporter = () => {}): { entry: SandboxEntry; warnings: string[] } {
    const n = name.trim();
    const problem = this.validateNewName(n);
    if (problem) {
      throw new Error(problem);
    }
    step(`создаю ветку ${n} от ${this.git!.currentBranch() ?? "HEAD"}`);
    this.git!.createBranch(n);
    const folder = this.folderFor(n);
    step(`создаю папку ${folder}`);
    fs.mkdirSync(folder, { recursive: true });
    const entry = this.registry.add({ name: n, absPath: folder, branch: n });
    this.registry.save();
    const warnings = this.switchTo(n, step);
    return { entry, warnings };
  }

  /**
   * Remove a sub-sandbox: its folder and sync state go to the trash, the git
   * branch stays. The active one cannot be removed.
   */
  remove(name: string, step: StepReporter = () => {}): { trashDir: string; warnings: string[] } {
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
    if (entry.stash) {
      warnings.push(`у ветки ${entry.branch} остался stash «${entry.stash}» — он в git stash list`);
    }
    this.registry.remove(entry.name);
    this.registry.save();
    return { trashDir, warnings };
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
