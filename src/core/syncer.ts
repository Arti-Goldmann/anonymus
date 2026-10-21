import { EventEmitter } from "node:events";
import * as path from "node:path";
import { watch, type FSWatcher } from "chokidar";
import type { FileStatus, SyncEngine, TransferResult } from "./engine.js";
import { gitBusy } from "./git.js";
import { mergeInEditor } from "./merge.js";
import type { PairProblem } from "./pairGuard.js";
import { toPosixRelative, type Side } from "./paths.js";

export type SyncEventKind =
  | "to-sandbox"
  | "to-project"
  | "deleted"
  | "merged"
  | "held"
  | "resolved"
  | "warning"
  | "error"
  | "info";

export interface SyncEvent {
  time: Date;
  kind: SyncEventKind;
  message: string;
  canonical?: string;
  replacements?: number;
  /** Pair the event belongs to (set by the caller that runs several pairs). */
  pair?: string;
}

export type Resolution = "project" | "sandbox" | "editor";

interface SyncerEvents {
  event: [SyncEvent];
  held: [FileStatus[]];
  state: [{ paused: boolean; busy: boolean; pending: number }];
  blocked: [PairProblem];
}

export interface SyncerOptions {
  /**
   * Is it safe to sync this pair? Called once a second and before every file.
   * A problem stops the syncer for good (see core/pairGuard.ts).
   */
  guard?: () => PairProblem | null;
  /** Git folder of the worktree: while git holds its index.lock nothing is applied. */
  gitDir?: string | null;
  /** Mass-deletion stop (default on); off for one run after the user confirmed. */
  massDeleteGuard?: boolean;
}

const MAX_RETRIES = 5;
/** How often the guard runs while idle (every applied file checks it too). */
const GUARD_POLL_MS = 1000;
/** Retry delay while another git command holds index.lock. */
const GIT_WAIT_MS = 200;
/** After this long behind index.lock, say in the log why nothing moves. */
const GIT_WAIT_REPORT_MS = 5000;
/** Deletions on one side within this window count as one wave. */
const MASS_DELETE_WINDOW_MS = 10_000;
/** A wave larger than max(MIN, SHARE × files of the pair) stops the pair. */
const MASS_DELETE_MIN = 5;
const MASS_DELETE_SHARE = 0.25;

/**
 * Live two-way sync of one pair. Watcher events only mark a canonical path as
 * dirty; a single worker then looks at what is actually on disk
 * (SyncEngine.classify) and acts. Because every decision comes from content +
 * the sync record, our own writes produce events that classify as "synced"
 * and are dropped — no echo loop, no timing heuristics.
 *
 * Files that need a human (conflicts, unknown differences) are "held": they
 * are not touched automatically until resolved.
 *
 * Safety: the guard (is this still the pair's own worktree, on its branch,
 * with its sandbox?) runs every second and before every file. A worktree
 * removed or re-created by git, a checkout inside it, a vanished sandbox —
 * any of these stops the syncer for good: queued events are dropped (they
 * come from the removal / checkout, not from edits) and `blocked` is emitted.
 * A wave of deletions on one side stops it the same way, before it spreads.
 */
export class Syncer extends EventEmitter<SyncerEvents> {
  private watchers: FSWatcher[] = [];
  private readonly dirty = new Set<string>();
  private readonly retries = new Map<string, number>();
  private readonly held = new Map<string, FileStatus>();
  private readonly reportedPathErrors = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private paused = false;
  private stopped = false;
  private guardTimer: NodeJS.Timeout | null = null;
  private problem: PairProblem | null = null;
  private gitBusySince = 0;
  /** The last save of the sync record failed (reported once until it works again). */
  private flushFailed = false;
  /** Recent deletions, by the side the files vanished on. */
  private readonly deletions: Record<Side, number[]> = { project: [], sandbox: [] };
  /** Largest number of files the pair had (deletions shrink the state). */
  private knownFiles: number;

  constructor(
    private readonly engine: SyncEngine,
    initiallyHeld: FileStatus[] = [],
    private readonly options: SyncerOptions = {}
  ) {
    super();
    for (const s of initiallyHeld) {
      this.held.set(s.canonical, s);
    }
    this.knownFiles = engine.state.size;
  }

  /** Set once the pair became unsafe to sync; the syncer stays stopped. */
  getProblem(): PairProblem | null {
    return this.problem;
  }

  getHeld(): FileStatus[] {
    return [...this.held.values()].sort((a, b) => a.canonical.localeCompare(b.canonical));
  }

  isPaused(): boolean {
    return this.paused;
  }

  /** Nothing queued, nothing running: both sides agree as far as the syncer knows. */
  isIdle(): boolean {
    return !this.running && this.dirty.size === 0 && this.timer === null;
  }

  async start(): Promise<void> {
    if (!this.checkGuard()) {
      return;
    }
    if (this.options.guard) {
      this.guardTimer = setInterval(() => this.checkGuard(), GUARD_POLL_MS);
      this.guardTimer.unref();
    }
    const ready = (["project", "sandbox"] as Side[]).map((side) => this.watchSide(side));
    await Promise.all(ready);
    if (this.problem || this.stopped) {
      return;
    }
    this.info("слежу за изменениями в проекте и песочнице");
    // Catch anything that changed between the scan and the watchers going up.
    this.rescan();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.stopGuard();
    await Promise.all(this.watchers.map((w) => w.close()));
    this.watchers = [];
    this.flushSafely();
  }

  pause(): void {
    this.paused = true;
    this.emitState();
  }

  resume(): void {
    this.paused = false;
    this.emitState();
    this.schedule();
  }

  /** Re-check every known and present file. */
  rescan(): void {
    if (this.problem || !this.checkGuard()) {
      return;
    }
    const { canonicals, pathErrors } = this.engine.listCandidates();
    for (const e of pathErrors) {
      this.reportPathError(e.side, e.path, e.problem);
    }
    for (const c of canonicals) {
      this.dirty.add(c);
    }
    this.schedule();
  }

  private watchSide(side: Side): Promise<void> {
    const root = this.engine.root(side);
    const toCanonical = (abs: string): string | null => {
      const rel = toPosixRelative(root, abs);
      if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
        return null;
      }
      return this.engine.canonicalOf(side, rel);
    };

    const watcher = watch(root, {
      ignoreInitial: true,
      persistent: true,
      usePolling: this.engine.config.sync.poll,
      interval: 500,
      awaitWriteFinish: {
        stabilityThreshold: Math.max(50, this.engine.config.sync.debounceMs),
        pollInterval: 50,
      },
      ignored: (abs, stats) => {
        const canonical = toCanonical(abs);
        if (canonical === null) {
          return false;
        }
        if (stats?.isFile()) {
          return !this.engine.filter.isSynced(canonical);
        }
        return this.engine.filter.isDirExcluded(canonical);
      },
    });
    this.watchers.push(watcher);

    const onFile = (abs: string) => {
      const rel = toPosixRelative(root, abs);
      if (side === "sandbox") {
        const problem = this.engine.mapper.sandboxPathProblem(rel);
        if (problem) {
          this.reportPathError(side, rel, problem);
          return;
        }
      }
      const canonical = toCanonical(abs);
      if (canonical !== null && this.engine.filter.isSynced(canonical)) {
        this.markDirty(canonical);
      }
    };
    const onDirRemoved = (abs: string) => {
      const rel = toPosixRelative(root, abs);
      for (const key of this.engine.state.keys()) {
        if (rel === "" || this.engine.mapper.sidePath(side, key).startsWith(rel + "/")) {
          this.markDirty(key);
        }
      }
    };

    watcher.on("add", onFile).on("change", onFile).on("unlink", onFile);
    watcher.on("unlinkDir", onDirRemoved);
    watcher.on("error", (err) => this.emitEvent("error", `наблюдение (${side}): ${String(err)}`));
    return new Promise((resolve) => watcher.once("ready", () => resolve()));
  }

  private markDirty(canonical: string): void {
    if (this.problem || this.stopped) {
      return; // after a removal / checkout every change is suspect
    }
    this.dirty.add(canonical);
    this.schedule();
  }

  private schedule(delay = this.engine.config.sync.debounceMs): void {
    if (this.stopped || this.paused || this.problem || this.timer) {
      this.emitState();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, delay);
    this.emitState();
  }

  private async drain(): Promise<void> {
    if (this.running || this.paused || this.stopped) {
      return;
    }
    this.running = true;
    this.emitState();
    let gitWait = false;
    try {
      while (this.dirty.size > 0 && !this.paused && !this.stopped) {
        // Checked per file: a removal or checkout may start in the middle of a batch.
        const gate = this.gate();
        if (gate !== "ok") {
          gitWait = gate === "wait";
          break;
        }
        const canonical = this.dirty.values().next().value as string;
        this.dirty.delete(canonical);
        this.processOne(canonical);
        // Let the UI render between files during big batches.
        await new Promise<void>((r) => setImmediate(r));
      }
      this.flushSafely();
    } finally {
      this.running = false;
      this.emitState();
    }
    if (gitWait) {
      this.schedule(GIT_WAIT_MS);
    }
  }

  /**
   * May files be applied now? "blocked" — the pair is unsafe; "wait" — a git
   * command holds the index (a checkout or merge writes files before it ends).
   */
  private gate(): "ok" | "wait" | "blocked" {
    if (!this.checkGuard()) {
      return "blocked";
    }
    const gitDir = this.options.gitDir;
    if (gitDir && gitBusy(gitDir)) {
      const now = Date.now();
      if (this.gitBusySince === 0) {
        this.gitBusySince = now;
      } else if (this.gitBusySince > 0 && now - this.gitBusySince > GIT_WAIT_REPORT_MS) {
        this.gitBusySince = -1; // reported
        this.info("git занят (index.lock) — синхронизация ждёт; если git не запущен, удалите этот файл");
      }
      return "wait";
    }
    this.gitBusySince = 0;
    return "ok";
  }

  /** Run the guard; false (and stopped for good) once the pair is unsafe. */
  private checkGuard(): boolean {
    if (this.problem) {
      return false;
    }
    const problem = this.options.guard?.() ?? null;
    if (problem) {
      this.block(problem);
      return false;
    }
    return true;
  }

  private block(problem: PairProblem): void {
    if (this.problem) {
      return;
    }
    this.problem = problem;
    this.dirty.clear();
    this.retries.clear();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.stopGuard();
    this.emitEvent("error", `${problem.message} — синхронизация остановлена`);
    this.emit("blocked", problem);
    this.emitState();
  }

  private stopGuard(): void {
    if (this.guardTimer) {
      clearInterval(this.guardTimer);
      this.guardTimer = null;
    }
  }

  /**
   * Count a deletion that vanished on `side`; false (pair stopped) when it
   * would make the current wave too big to be an ordinary edit.
   */
  private allowDeletion(side: Side): boolean {
    if (this.options.massDeleteGuard === false) {
      return true;
    }
    const now = Date.now();
    const recent = this.deletions[side].filter((t) => now - t < MASS_DELETE_WINDOW_MS);
    this.knownFiles = Math.max(this.knownFiles, this.engine.state.size);
    const limit = Math.max(MASS_DELETE_MIN, Math.ceil(this.knownFiles * MASS_DELETE_SHARE));
    if (recent.length >= limit) {
      const where = side === "project" ? "в worktree проекта" : "в песочнице";
      this.block({
        code: "mass-delete",
        side,
        count: recent.length + 1 + this.dirty.size,
        message: `${where} разом исчезло больше ${limit} файлов — удаления не перенесены на другую сторону`,
      });
      return false;
    }
    recent.push(now);
    this.deletions[side] = recent;
    return true;
  }

  private processOne(canonical: string): void {
    let status: FileStatus;
    try {
      status = this.engine.classify(canonical);
      if (this.held.has(canonical)) {
        this.refreshHeld(status);
        return;
      }
      this.act(status);
      this.retries.delete(canonical);
    } catch (e) {
      // Typically EBUSY/EPERM: an editor or the agent still holds the file.
      const n = (this.retries.get(canonical) ?? 0) + 1;
      if (n <= MAX_RETRIES) {
        this.retries.set(canonical, n);
        setTimeout(() => this.markDirty(canonical), 500 * n);
      } else {
        this.retries.delete(canonical);
        this.emitEvent("error", `${canonical}: ${(e as Error).message}`, canonical);
      }
    }
  }

  private act(status: FileStatus): void {
    const c = status.canonical;
    switch (status.kind) {
      case "synced":
        if (!this.engine.state.get(c)) {
          this.engine.record(c);
        }
        return;
      case "only-project":
      case "project-changed":
        this.reportTransfer(this.engine.copy("project", c));
        return;
      case "only-sandbox":
      case "sandbox-changed":
        this.reportTransfer(this.engine.copy("sandbox", c));
        return;
      case "deleted-in-sandbox":
        if (this.allowDeletion("sandbox")) {
          this.reportDelete("project", c);
        }
        return;
      case "deleted-in-project":
        if (this.allowDeletion("project")) {
          this.reportDelete("sandbox", c);
        }
        return;
      case "both-changed": {
        if (!status.deletedOn && !status.binary) {
          const merged = this.engine.autoMerge(c);
          if (merged.ok) {
            this.emitEvent("merged", `${c}: правки с обеих сторон слиты автоматически`, c);
            for (const w of merged.warnings) {
              this.emitEvent("warning", `${c}: ${w}`, c);
            }
            return;
          }
        }
        this.hold(status);
        return;
      }
      case "differs-unknown":
        this.hold(status);
        return;
      case "error":
        this.reportPathError("project", c, status.problem ?? "ошибка пути");
        return;
      case "gone":
      case "ignored":
        this.engine.state.delete(c);
        return;
    }
  }

  private hold(status: FileStatus): void {
    this.held.set(status.canonical, status);
    const why = status.deletedOn
      ? `удалён в ${status.deletedOn === "project" ? "проекте" : "песочнице"}, но изменён на другой стороне`
      : status.kind === "differs-unknown"
        ? "различается, истории синхронизации нет"
        : "изменён с обеих сторон, автослияние не удалось";
    this.emitEvent("held", `${status.canonical}: ${why} — нужно решение (клавиша c)`, status.canonical);
    this.emit("held", this.getHeld());
  }

  /** A held file may get fixed by hand; release it once both sides agree. */
  private refreshHeld(status: FileStatus): void {
    if (status.kind === "synced" || status.kind === "gone" || status.kind === "ignored") {
      this.held.delete(status.canonical);
      if (status.kind === "synced") {
        this.engine.record(status.canonical);
      }
      this.emitEvent("resolved", `${status.canonical}: стороны совпадают, синхронизация возобновлена`, status.canonical);
    } else {
      this.held.set(status.canonical, status);
    }
    this.emit("held", this.getHeld());
  }

  /** Resolve a held file by the user's choice. */
  async resolve(canonical: string, how: Resolution): Promise<{ ok: boolean; message: string }> {
    if (this.problem || !this.checkGuard()) {
      return { ok: false, message: `${this.problem?.message ?? "пара недоступна"} — сначала разберитесь с этим` };
    }
    const status = this.engine.classify(canonical);
    try {
      if (how === "editor") {
        const p = this.engine.read("project", canonical);
        const s = this.engine.read("sandbox", canonical);
        if (!p || !s || status.binary) {
          return { ok: false, message: "слияние в редакторе возможно только для текстового файла, существующего с обеих сторон" };
        }
        const t = this.engine.transformer;
        const base = this.engine.baseText(canonical);
        const result = await mergeInEditor({
          projectRoot: this.engine.serviceRoot,
          canonical,
          ours: this.engine.decodeSide("project", p).text,
          theirs: t.deanonymize(this.engine.decodeSide("sandbox", s).text).text,
          base: base === null ? "" : t.deanonymize(base).text,
        });
        if (!result.ok) {
          return { ok: false, message: result.reason };
        }
        if (!this.checkGuard()) {
          return { ok: false, message: `${this.problem!.message} — результат слияния не записан` };
        }
        this.reportTransfer(this.engine.writeResolved(canonical, result.text), "resolved");
      } else {
        const exists = this.engine.read(how, canonical) !== null;
        if (exists) {
          this.reportTransfer(this.engine.copy(how, canonical), "resolved");
        } else {
          // The chosen side deleted the file: apply the deletion.
          this.reportDelete(how === "project" ? "sandbox" : "project", canonical);
        }
      }
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
    this.held.delete(canonical);
    this.flushSafely();
    this.emit("held", this.getHeld());
    return { ok: true, message: "готово" };
  }

  private reportTransfer(r: TransferResult, kind?: SyncEventKind): void {
    const arrow = r.to === "sandbox" ? "проект → песочница" : "песочница → проект";
    const shown = r.to === "sandbox" ? this.engine.mapper.toSandbox(r.canonical) : r.canonical;
    this.emitEvent(kind ?? (r.to === "sandbox" ? "to-sandbox" : "to-project"), `${arrow}  ${shown}`, r.canonical, r.replacements);
    if (r.leaks.length > 0) {
      this.emitEvent("warning", `возможная утечка в ${shown}: ${r.leaks.join(", ")} — дополните replacements`, r.canonical);
    }
    for (const w of r.warnings) {
      this.emitEvent("warning", `${shown}: ${w}`, r.canonical);
    }
    if (r.backup) {
      this.emitEvent("info", `прежняя версия сохранена: ${path.relative(this.engine.serviceRoot, r.backup)}`, r.canonical);
    }
  }

  private reportDelete(side: Side, canonical: string): void {
    const shown = this.engine.mapper.sidePath(side, canonical);
    const backup = this.engine.remove(side, canonical);
    const where = side === "project" ? "в проекте" : "в песочнице";
    this.emitEvent(
      "deleted",
      `удалён ${where}  ${shown}${backup ? "  (копия в .anonymus/trash)" : ""}`,
      canonical
    );
  }

  private reportPathError(side: Side, rel: string, problem: string): void {
    const key = `${side}:${rel}`;
    if (this.reportedPathErrors.has(key)) {
      return;
    }
    this.reportedPathErrors.add(key);
    this.emitEvent("error", `${side === "project" ? "проект" : "песочница"} ${rel}: ${problem} — файл не синхронизируется`);
  }

  /**
   * Save the sync record. A failure (the file held open by another program,
   * the disk full) must not stop syncing: nothing on either side is lost —
   * the record is only a memory of what matched — so it is reported and
   * saved again with the next change.
   */
  private flushSafely(): void {
    try {
      this.engine.flush();
      this.flushFailed = false;
    } catch (e) {
      if (!this.flushFailed) {
        this.flushFailed = true;
        this.emitEvent(
          "warning",
          `не удалось сохранить историю синхронизации (${(e as Error).message}) — сохраню при следующем изменении`
        );
      }
    }
  }

  private info(message: string): void {
    this.emitEvent("info", message);
  }

  private emitEvent(kind: SyncEventKind, message: string, canonical?: string, replacements?: number): void {
    this.emit("event", { time: new Date(), kind, message, canonical, replacements });
  }

  private emitState(): void {
    this.emit("state", { paused: this.paused, busy: this.running, pending: this.dirty.size });
  }
}
