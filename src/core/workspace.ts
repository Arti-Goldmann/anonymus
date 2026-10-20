import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isInside } from "../config/loader.js";
import { SERVICE_DIR, type AnonymusConfig } from "../config/schema.js";
import { SyncEngine } from "./engine.js";
import { Git, readWorktreeLink } from "./git.js";
import { checkPair, findMarkedWorktree, pairGitDir, writeMark, type PairProblem } from "./pairGuard.js";
import { Registry, type SandboxEntry } from "./registry.js";
import { Transformer } from "./transformer.js";
import { trashStamp } from "./trash.js";

/** Progress callback for multi-step operations (shown in the UI). */
export type StepReporter = (message: string) => void;

/** One sync pair as the UI sees it. */
export interface PairRef {
  name: string;
  /** Branch of the worktree; null for a project without git. */
  branch: string | null;
  /** Project side: the pair's worktree (the main folder without git). */
  projectDir: string;
  sandboxDir: string;
  /** Registry entry; null for the single pair of a project without git. */
  entry: SandboxEntry | null;
}

/** Name of the single pair of a project that is not a git repository. */
export const PLAIN_PAIR = "default";

/**
 * The project and its sync pairs.
 *
 * In a git project every sub-sandbox is paired with its own git worktree of
 * the project (created next to it, in `worktrees_dir`), and all pairs sync at
 * the same time. The main project folder is never synced: it belongs to the
 * user, who may check out whatever they like there.
 *
 * Without git there is exactly one pair: the project folder ⇄ `sandbox:`.
 */
export class Workspace {
  readonly git: Git | null;
  /** Null for a project without git. */
  readonly registry: Registry | null;
  /** The repository's shared .git folder. */
  readonly commonGitDir: string | null;
  private readonly transformer: Transformer;

  constructor(readonly config: AnonymusConfig) {
    const git = new Git(config.projectRoot);
    this.git = git.isRepo() ? git : null;
    this.commonGitDir = this.git?.commonGitDir() ?? null;
    this.transformer = new Transformer(config.replacements);
    this.registry = this.git ? new Registry(config) : null;
  }

  get gitEnabled(): boolean {
    return this.git !== null;
  }

  /** Configuration problems that make syncing unsafe (empty when fine). */
  problems(): string[] {
    if (!this.registry) {
      return this.config.profile.sandboxRoot ? [] : ["проект не git-репозиторий: укажите sandbox: в anonymus.yaml"];
    }
    return this.registry.overlaps();
  }

  pairs(): PairRef[] {
    if (!this.registry) {
      if (!this.config.profile.sandboxRoot) {
        return [];
      }
      return [
        {
          name: PLAIN_PAIR,
          branch: null,
          projectDir: this.config.projectRoot,
          sandboxDir: this.config.profile.sandboxRoot,
          entry: null,
        },
      ];
    }
    return this.registry.list().map((e) => ({
      name: e.name,
      branch: e.branch,
      projectDir: e.worktree,
      sandboxDir: e.sandbox,
      entry: e,
    }));
  }

  pair(name: string): PairRef {
    const p = this.pairs().find((x) => x.name === name);
    if (!p) {
      throw new Error(`нет подпесочницы «${name}»`);
    }
    return p;
  }

  private entry(name: string): SandboxEntry {
    const e = this.registry?.get(name);
    if (!e) {
      throw new Error(`нет подпесочницы «${name}»`);
    }
    return e;
  }

  /** A fresh sync engine for one pair (loads its sync state from disk). */
  engineFor(name: string): SyncEngine {
    if (!this.registry) {
      return new SyncEngine(this.config);
    }
    return new SyncEngine({ ...this.config, profile: this.registry.profileOf(this.entry(name)) });
  }

  /**
   * Is it safe to sync this pair right now? See core/pairGuard.ts. Called
   * before the first scan and continuously while syncing.
   */
  check(name: string, hasHistory: boolean): PairProblem | null {
    if (!this.registry) {
      return hasHistory && !fs.existsSync(this.config.profile.sandboxRoot)
        ? { code: "sandbox-missing", message: `папки песочницы ${this.config.profile.sandboxRoot} нет` }
        : null;
    }
    return checkPair(this.entry(name), this.commonGitDir!, { hasHistory });
  }

  /** Git folder of the pair's worktree (HEAD, index.lock), if it is ours. */
  gitDirOf(name: string): string | null {
    if (!this.registry) {
      return this.git ? this.git.gitDir() : null;
    }
    return pairGitDir(this.entry(name), this.commonGitDir!);
  }

  /** Git of the pair's worktree. Refuses when the folder is not the pair's worktree. */
  gitOf(name: string): Git {
    const problem = this.check(name, false);
    if (problem) {
      throw new Error(problem.message);
    }
    return new Git(this.entry(name).worktree);
  }

  // --- creating ------------------------------------------------------------

  /** Sandbox folder a new pair would get (placeholder names only). */
  folderFor(name: string): string {
    return path.join(this.config.sandboxesDir, this.transformer.anonymizePath(safeName(name)));
  }

  /** Worktree folder a new pair would get (the user's side: real names are fine). */
  worktreeFor(name: string): string {
    return path.join(this.config.worktreesDir, safeName(name));
  }

  /** Branches a new pair can start from: the main folder's branch first. */
  baseBranchChoices(): string[] {
    if (!this.git) {
      return [];
    }
    const current = this.git.currentBranch();
    const pairs = this.registry!.list().map((s) => s.branch);
    return [...new Set([...(current ? [current] : []), ...pairs, ...this.git.listBranches()])];
  }

  /** Why `name` cannot be used for a new pair, or null if it can. */
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
    if (this.registry!.get(n) || this.registry!.list().some((s) => s.branch === n)) {
      return `подпесочница «${n}» уже есть`;
    }
    if (this.git.branchExists(n)) {
      const taken = this.git.worktreeList().find((w) => w.branch === n);
      if (taken) {
        return `ветка ${n} уже выбрана в ${taken.path} — git не даёт выбрать одну ветку в двух папках`;
      }
    }
    const sandbox = this.folderFor(n);
    const wtDir = this.config.worktreesDir;
    if (isInside(sandbox, wtDir) || isInside(wtDir, sandbox)) {
      return `папка песочницы ${sandbox} пересеклась бы с папкой worktree ${wtDir} — выберите другое имя`;
    }
    for (const [label, folder] of [
      ["worktree", this.worktreeFor(n)],
      ["песочницы", sandbox],
    ] as const) {
      if (isInside(folder, this.config.projectRoot)) {
        return `папка ${label} ${folder} оказалась бы внутри проекта — проверьте sandboxes_dir / worktrees_dir`;
      }
      if (fs.existsSync(folder) && fs.readdirSync(folder).length > 0) {
        return `папка ${label} ${folder} уже существует и не пуста`;
      }
    }
    return null;
  }

  /** Does a new pair with this name reuse an existing branch? */
  isExistingBranch(name: string): boolean {
    return this.git?.branchExists(name.trim()) ?? false;
  }

  /**
   * New pair: a branch (new from `from`, or an existing one that is not
   * checked out anywhere), its worktree with the ownership mark, and an
   * empty sandbox folder — the first scan fills it from the worktree.
   */
  async create(
    name: string,
    options: { from?: string } = {},
    step: StepReporter = () => {},
    warn: StepReporter = () => {}
  ): Promise<SandboxEntry> {
    const n = name.trim();
    const problem = this.validateNewName(n);
    if (problem) {
      throw new Error(problem);
    }
    const git = this.git!;
    let base: SandboxEntry["base"] = null;
    let createdBranch = false;
    if (!git.branchExists(n)) {
      const from = options.from ?? git.currentBranch() ?? "HEAD";
      if (from !== "HEAD" && !git.branchExists(from)) {
        throw new Error(`нет ветки ${from}`);
      }
      const commit = git.commitOf(from);
      step(`создаю ветку ${n} от ${from}`);
      git.createBranch(n, from);
      createdBranch = true;
      base = from === "HEAD" ? null : { branch: from, commit };
    }
    const worktree = this.worktreeFor(n);
    step(`git worktree add ${worktree}`);
    try {
      fs.mkdirSync(path.dirname(worktree), { recursive: true });
      await git.worktreeAdd(worktree, n);
    } catch (e) {
      if (createdBranch) {
        git.deleteBranch(n);
      }
      throw e;
    }
    const entry = this.registry!.add({
      name: n,
      branch: n,
      worktree,
      worktreeId: randomUUID(),
      sandbox: this.folderFor(n),
      base,
      needsReview: false,
      merge: null,
    });
    this.markWorktree(entry);
    await this.initSubmodules(entry, step, warn);
    step(`создаю папку песочницы ${entry.sandbox}`);
    fs.mkdirSync(entry.sandbox, { recursive: true });
    this.registry!.save();
    return entry;
  }

  /**
   * `git worktree add` leaves submodule folders empty, so the sandbox would
   * not get them. A failure (no network, no access) does not stop the pair:
   * it is reported, and the same command can be run by hand later.
   */
  private async initSubmodules(entry: SandboxEntry, step: StepReporter, warn: StepReporter): Promise<void> {
    if (!new Git(entry.worktree).hasSubmodules()) {
      return;
    }
    const failed = await this.checkoutSubmodules(entry.worktree, this.config.projectRoot, step);
    if (failed.length > 0) {
      warn(
        `подмодули не скачались: ${failed.join("; ")} — их папки в песочнице будут пустыми; ` +
          `повторите вручную: git -C "${entry.worktree}" submodule update --init --recursive`
      );
    }
  }

  /**
   * Check out the submodules of `dir`, recursively. Each one is cloned from
   * the copy in the main folder (`mainDir`) when that copy has the pinned
   * commit — seconds instead of a network clone — and then pointed at the
   * same remote as that copy, so later fetches go to the real server.
   * Otherwise it is cloned from its URL. Returns what could not be fetched.
   */
  private async checkoutSubmodules(dir: string, mainDir: string | null, step: StepReporter): Promise<string[]> {
    const git = new Git(dir);
    const failed: string[] = [];
    for (const sub of git.submodules()) {
      const sha = git.submoduleCommit(sub.path);
      if (!sha) {
        continue; // declared in .gitmodules but not part of this commit
      }
      const target = path.join(dir, ...sub.path.split("/"));
      const local = mainDir ? path.join(mainDir, ...sub.path.split("/")) : null;
      const localGit = local && readWorktreeLink(local).kind !== "missing" ? new Git(local) : null;
      let done = false;
      if (localGit?.hasCommit(sha)) {
        step(`подмодуль ${sub.path}: копирую из основной папки проекта`);
        try {
          await git.submoduleUpdate(sub.path, { fromLocal: { name: sub.name, dir: local! } });
          const url = localGit.originUrl();
          if (url) {
            new Git(target).setOriginUrl(url);
          }
          done = true;
        } catch {
          // fall back to the network below
        }
      }
      if (!done) {
        step(`подмодуль ${sub.path}: скачиваю по сети — это может занять время`);
        try {
          await git.submoduleUpdate(sub.path);
        } catch (e) {
          failed.push(`${sub.path} (${(e as Error).message})`);
          continue;
        }
      }
      if (new Git(target).hasSubmodules()) {
        failed.push(...(await this.checkoutSubmodules(target, localGit ? local : null, step)));
      }
    }
    return failed;
  }

  private markWorktree(entry: SandboxEntry): void {
    const link = readWorktreeLink(entry.worktree);
    if (link.kind !== "worktree") {
      throw new Error(`${entry.worktree}: git не создал worktree`);
    }
    writeMark(link.gitDir, entry);
  }

  // --- removing ------------------------------------------------------------

  /** Uncommitted files in the pair's worktree (empty when it is not ours or gone). */
  uncommitted(name: string): string[] {
    try {
      return this.gitOf(name).changedFiles();
    } catch {
      return [];
    }
  }

  /**
   * Remove a pair. The sandbox and the sync state go to the trash, the
   * worktree is removed with git (with `force`, its uncommitted files are
   * copied to the trash first), the branch stays. A folder that is not the
   * pair's worktree is never touched.
   */
  remove(
    name: string,
    options: { force?: boolean } = {},
    step: StepReporter = () => {}
  ): { trashDir: string; warnings: string[] } {
    const entry = this.entry(name);
    const git = this.git!;
    const warnings: string[] = [];
    const trashDir = this.trashDirFor(entry.name);

    const problem = checkPair(entry, this.commonGitDir!, { hasHistory: false });
    if (!problem || problem.code === "wrong-branch") {
      const wtGit = new Git(entry.worktree);
      const dirty = wtGit.changedFiles();
      if (dirty.length > 0 && !options.force) {
        throw new Error(
          `в worktree ${entry.worktree} незакоммиченные изменения (${dirty.length}) — ` +
            "закоммитьте их (k) или удалите принудительно"
        );
      }
      for (const file of dirty) {
        const from = path.join(entry.worktree, ...file.split("/"));
        const to = path.join(trashDir, "worktree", ...file.split("/"));
        if (!fs.existsSync(from)) {
          continue;
        }
        fs.mkdirSync(path.dirname(to), { recursive: true });
        if (fs.statSync(from).isFile()) {
          fs.copyFileSync(from, to);
        } else {
          // A submodule with changes inside: keep its whole working copy.
          fs.cpSync(from, to, { recursive: true, filter: (src) => path.basename(src) !== ".git" });
        }
      }
      step(`git worktree remove ${entry.worktree}`);
      // git refuses to remove a worktree with submodules unless forced; any
      // uncommitted work in it was refused above or backed up just now.
      git.worktreeRemove(entry.worktree, dirty.length > 0 || wtGit.hasSubmodules());
    } else if (problem.code === "worktree-missing" || problem.code === "sandbox-missing") {
      git.worktreePrune();
    } else {
      warnings.push(`папка ${entry.worktree} не тронута: это не worktree подпесочницы (${problem.message})`);
    }

    if (fs.existsSync(entry.sandbox)) {
      step(`переношу ${entry.sandbox} в корзину`);
      moveDir(entry.sandbox, uniquePath(path.join(trashDir, path.basename(entry.sandbox))));
    }
    this.discardState(entry.name, trashDir);
    this.registry!.remove(entry.name);
    this.registry!.save();
    return { trashDir, warnings };
  }

  // --- recovering from a problem --------------------------------------------

  /**
   * The worktree is gone or replaced: create it again at its path from the
   * pair's branch. Whatever is in that folder now goes to the trash first.
   * Its uncommitted work is lost while the sandbox may still have it, so the
   * old sync history is dropped and the pair waits for a review.
   */
  async recreateWorktree(name: string, step: StepReporter = () => {}, warn: StepReporter = () => {}): Promise<void> {
    const entry = this.entry(name);
    const git = this.git!;
    if (!git.branchExists(entry.branch)) {
      throw new Error(`ветки ${entry.branch} больше нет — пересоздать worktree не из чего`);
    }
    const trashDir = this.trashDirFor(entry.name);
    if (fs.existsSync(entry.worktree)) {
      step(`переношу ${entry.worktree} в корзину`);
      moveDir(entry.worktree, uniquePath(path.join(trashDir, "worktree")));
    }
    git.worktreePrune();
    const taken = git.worktreeList().find((w) => w.branch === entry.branch);
    if (taken) {
      throw new Error(`ветка ${entry.branch} выбрана в ${taken.path} — освободите её там`);
    }
    step(`git worktree add ${entry.worktree} ${entry.branch}`);
    fs.mkdirSync(path.dirname(entry.worktree), { recursive: true });
    await git.worktreeAdd(entry.worktree, entry.branch);
    entry.worktreeId = randomUUID();
    this.markWorktree(entry);
    await this.initSubmodules(entry, step, warn);
    this.requireReview(entry, trashDir);
  }

  /**
   * The user confirms that the folder IS the pair's worktree (e.g. they
   * re-created it themselves): mark it as ours. It must be a worktree of this
   * repository on the pair's branch. Waits for a review like recreateWorktree.
   */
  relink(name: string): void {
    const entry = this.entry(name);
    const link = readWorktreeLink(entry.worktree);
    if (link.kind !== "worktree" || !isInside(link.gitDir, path.join(this.commonGitDir!, "worktrees"))) {
      throw new Error(`${entry.worktree} — не worktree этого репозитория, привязать нельзя`);
    }
    const branch = new Git(entry.worktree).currentBranch();
    if (branch !== entry.branch) {
      throw new Error(`в ${entry.worktree} выбрана ${branch ?? "отделённая HEAD"}, а нужна ветка ${entry.branch}`);
    }
    entry.worktreeId = randomUUID();
    writeMark(link.gitDir, entry);
    this.requireReview(entry, this.trashDirFor(entry.name));
  }

  /** The worktree was moved with `git worktree move`: where it is now, if found. */
  movedTo(name: string): string | null {
    const entry = this.entry(name);
    const found = findMarkedWorktree(this.commonGitDir!, entry.worktreeId);
    return found && path.resolve(found) !== path.resolve(entry.worktree) ? found : null;
  }

  /** Follow a worktree moved with `git worktree move` (same worktree, same mark). */
  relocate(name: string): string {
    const entry = this.entry(name);
    const found = this.movedTo(name);
    if (!found) {
      throw new Error("worktree с меткой этой подпесочницы не найден");
    }
    entry.worktree = found;
    this.registry!.save();
    return found;
  }

  /** Someone checked out another branch inside the worktree: put the pair's branch back. */
  checkoutBack(name: string): void {
    const entry = this.entry(name);
    new Git(entry.worktree).checkout(entry.branch);
  }

  /**
   * The sandbox folder vanished: start it over empty. The old sync history
   * no longer describes anything, so it goes to the trash; the next scan
   * fills the sandbox from the worktree.
   */
  refillSandbox(name: string): void {
    if (!this.registry) {
      this.discardState(PLAIN_PAIR, this.trashDirFor(PLAIN_PAIR));
      fs.mkdirSync(this.config.profile.sandboxRoot, { recursive: true });
      return;
    }
    const entry = this.entry(name);
    this.discardState(entry.name, this.trashDirFor(entry.name));
    fs.mkdirSync(entry.sandbox, { recursive: true });
  }

  /** The user reconciled a pair that was waiting for a review. */
  markReviewed(name: string): void {
    const entry = this.registry?.get(name);
    if (entry?.needsReview) {
      entry.needsReview = false;
      this.registry!.save();
    }
  }

  private requireReview(entry: SandboxEntry, trashDir: string): void {
    this.discardState(entry.name, trashDir);
    entry.needsReview = true;
    this.registry!.save();
  }

  // --- committing ----------------------------------------------------------

  defaultCommitMessage(name: string): string {
    return `Изменения подпесочницы ${name}`;
  }

  /** Commit everything uncommitted in the pair's worktree. False when there was nothing. */
  commit(name: string, message = this.defaultCommitMessage(name)): boolean {
    if (!this.git) {
      throw new Error("проект не является git-репозиторием");
    }
    return this.gitOf(name).commitAll(message);
  }

  // --- helpers ---------------------------------------------------------------

  private trashDirFor(name: string): string {
    return path.join(this.config.projectRoot, SERVICE_DIR, "trash", trashStamp(), ...name.split("/"));
  }

  /** Move a pair's sync state (history and merge bases) to the trash. */
  private discardState(name: string, trashDir: string): void {
    const stateDir = path.join(this.config.projectRoot, SERVICE_DIR, "profiles", ...name.split("/"));
    if (fs.existsSync(stateDir)) {
      moveDir(stateDir, uniquePath(path.join(trashDir, "state")));
    }
  }
}

/** A pair name as a folder name. */
function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|\s]+/g, "-");
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
