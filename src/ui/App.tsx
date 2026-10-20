import * as fs from "node:fs";
import * as path from "node:path";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { SERVICE_DIR } from "../config/schema.js";
import type { FileStatus, SyncEngine } from "../core/engine.js";
import { abortMerge, continueMerge, startMerge, type MergeOutcome } from "../core/gitMerge.js";
import type { PairProblem } from "../core/pairGuard.js";
import { applyReconcile, planReconcile, summarize, type Strategy } from "../core/reconcile.js";
import { scan } from "../core/scanner.js";
import { Syncer, type SyncEvent } from "../core/syncer.js";
import type { PairRef, Workspace } from "../core/workspace.js";
import { openFolder } from "../platform.js";
import { ConflictView } from "./ConflictView.js";
import { CompactHeader, Header, HEADER_MIN_COLUMNS, HEADER_ROWS, type PairsSummary } from "./Header.js";
import { PairsView } from "./PairsView.js";
import { needsAttention, ZERO_STATS, type ActionResult, type Phase, type PairView } from "./pairState.js";
import { ProblemView, type ProblemAction } from "./ProblemView.js";
import { RECONCILE_COMPACT_ROWS, RECONCILE_FULL_ROWS, ReconcileView } from "./ReconcileView.js";
import { formatTime, plural, theme } from "./theme.js";
import { useTerminalSize } from "./useTerminalSize.js";

type Screen =
  | { kind: "overview" }
  | { kind: "reconcile"; pair: string }
  | { kind: "conflicts"; pair: string }
  | { kind: "problem"; pair: string }
  | { kind: "stopping" };

/** Events kept in memory for the on-screen log (the journal file has all). */
const MAX_EVENTS = 2000;

/** Shown on the reconcile screen of a pair whose worktree was re-created or re-linked. */
const REVIEW_NOTE =
  "Worktree этой подпесочницы создан заново: его незакоммиченная работа могла пропасть, а в песочнице она есть. " +
  "Рекомендуется «Песочница → проект».";

const now = () => new Date();

function viewOf(ref: PairRef): PairView {
  return {
    name: ref.name,
    branch: ref.branch,
    base: ref.entry?.base?.branch ?? null,
    phase: "waiting",
    problem: null,
    held: 0,
    paused: false,
    busy: false,
    pending: 0,
    stats: ZERO_STATS,
    progress: [0, 0],
    scan: null,
    needsReview: !!ref.entry?.needsReview,
    merge: ref.entry?.merge ?? null,
  };
}

/**
 * Root component. The whole UI is one frame exactly as tall as the window
 * (drawn on the terminal's alternate screen, see cli.tsx), so resizing just
 * redraws the frame — nothing is left behind in the scrollback.
 *
 * Every pair (sub-sandbox ⇄ its worktree) runs on its own: check → scan →
 * (automatic reconcile | waits for the user) → live sync. A pair that becomes
 * unsafe stops alone; the others keep syncing.
 */
export function App({
  workspace,
  version,
  warnings,
}: {
  workspace: Workspace;
  version: string;
  warnings: string[];
}) {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const engines = useRef(new Map<string, SyncEngine>());
  const syncers = useRef(new Map<string, Syncer>());
  const [pairs, setPairs] = useState<PairView[]>(() => workspace.pairs().map(viewOf));
  const [heldFiles, setHeldFiles] = useState<Record<string, FileStatus[]>>({});
  const [screen, setScreen] = useState<Screen>({ kind: "overview" });
  const [events, setEvents] = useState<SyncEvent[]>(() =>
    warnings.map((w) => ({ time: now(), kind: "warning" as const, message: w }))
  );
  const [fatal, setFatal] = useState<string | null>(null);
  const journal = useMemo(() => path.join(workspace.config.projectRoot, SERVICE_DIR, "anonymus.log"), [workspace]);

  const update = useCallback((name: string, patch: Partial<PairView>) => {
    setPairs((prev) => prev.map((p) => (p.name === name ? { ...p, ...patch } : p)));
  }, []);

  /** Re-read the pair list from the registry, keeping the live state of known pairs. */
  const syncList = useCallback(() => {
    setPairs((prev) =>
      workspace.pairs().map((ref) => {
        const old = prev.find((p) => p.name === ref.name);
        const fresh = viewOf(ref);
        return old ? { ...old, branch: fresh.branch, base: fresh.base, merge: fresh.merge, needsReview: fresh.needsReview } : fresh;
      })
    );
  }, [workspace]);

  const pushEvent = useCallback(
    (ev: SyncEvent) => {
      setEvents((prev) => [...prev.slice(-(MAX_EVENTS - 1)), ev]);
      if (ev.pair && (ev.kind === "to-sandbox" || ev.kind === "to-project" || ev.kind === "deleted")) {
        setPairs((prev) =>
          prev.map((p) =>
            p.name === ev.pair
              ? {
                  ...p,
                  stats: {
                    toSandbox: p.stats.toSandbox + (ev.kind === "to-sandbox" ? 1 : 0),
                    toProject: p.stats.toProject + (ev.kind === "to-project" ? 1 : 0),
                    deleted: p.stats.deleted + (ev.kind === "deleted" ? 1 : 0),
                  },
                }
              : p
          )
        );
      }
      try {
        fs.mkdirSync(path.dirname(journal), { recursive: true });
        const date = ev.time.toISOString().slice(0, 10);
        fs.appendFileSync(
          journal,
          `${date} ${formatTime(ev.time)}  [${ev.pair ?? "-"}] ${ev.kind.padEnd(10)} ${ev.message}\n`,
          "utf8"
        );
      } catch {
        // The journal is a convenience; never break syncing over it.
      }
    },
    [journal]
  );
  const info = useCallback(
    (message: string, pair?: string) => pushEvent({ time: now(), kind: "info", message, pair }),
    [pushEvent]
  );
  const warn = useCallback(
    (message: string, pair?: string) => pushEvent({ time: now(), kind: "warning", message, pair }),
    [pushEvent]
  );
  const error = useCallback(
    (message: string, pair?: string) => pushEvent({ time: now(), kind: "error", message, pair }),
    [pushEvent]
  );

  const leaveScreensOf = useCallback((name: string) => {
    setScreen((s) => (s.kind !== "overview" && s.kind !== "stopping" && s.pair === name ? { kind: "overview" } : s));
  }, []);

  const stopPair = useCallback(async (name: string) => {
    const s = syncers.current.get(name);
    syncers.current.delete(name);
    if (s) {
      s.removeAllListeners();
      await s.stop();
    }
  }, []);

  const block = useCallback(
    (name: string, problem: PairProblem) => {
      update(name, { phase: "blocked", problem, busy: false, pending: 0 });
      leaveScreensOf(name);
    },
    [update, leaveScreensOf]
  );

  const reportOutcome = useCallback(
    (name: string, eng: SyncEngine, outcome: Awaited<ReturnType<typeof applyReconcile>>, label: string) => {
      info(
        `${label}: в песочницу ${outcome.transfers.filter((t) => t.to === "sandbox").length}, ` +
          `в проект ${outcome.transfers.filter((t) => t.to === "project").length}, ` +
          `удалено ${outcome.deleted}, слито ${outcome.merged}, на решение ${outcome.held.length}`,
        name
      );
      for (const t of outcome.transfers) {
        if (t.leaks.length > 0) {
          warn(`возможная утечка в ${eng.mapper.toSandbox(t.canonical)}: ${t.leaks.join(", ")}`, name);
        }
      }
      for (const f of outcome.failures) {
        error(`${f.status.canonical}: ${f.error}`, name);
      }
    },
    [info, warn, error]
  );

  const startLive = useCallback(
    async (name: string, eng: SyncEngine, initiallyHeld: FileStatus[], massDeleteGuard = true) => {
      const syncer = new Syncer(eng, initiallyHeld, {
        guard: () => workspace.check(name, eng.state.size > 0),
        gitDir: workspace.gitDirOf(name),
        massDeleteGuard,
      });
      syncers.current.set(name, syncer);
      syncer.on("event", (ev) => pushEvent({ ...ev, pair: name }));
      syncer.on("held", (h) => {
        setHeldFiles((prev) => ({ ...prev, [name]: h }));
        update(name, { held: h.length });
      });
      syncer.on("state", (s) => update(name, { paused: s.paused, busy: s.busy, pending: s.pending }));
      syncer.on("blocked", (problem) => {
        block(name, problem);
        void stopPair(name);
      });
      const held = syncer.getHeld();
      setHeldFiles((prev) => ({ ...prev, [name]: held }));
      update(name, { phase: "live", problem: null, held: held.length, scan: null });
      await syncer.start();
    },
    [workspace, pushEvent, update, block, stopPair]
  );

  /**
   * Bring one pair up: safety check, scan, then reconcile — automatically when
   * it is unambiguous (an empty sandbox to fill, or only one-sided changes
   * since the last sync), otherwise it waits for the user — and live sync.
   */
  const bringUp = useCallback(
    async (name: string, massDeleteGuard = true): Promise<Phase> => {
      await stopPair(name);
      const eng = workspace.engineFor(name);
      engines.current.set(name, eng);
      setHeldFiles((prev) => ({ ...prev, [name]: [] }));
      update(name, { phase: "scanning", problem: null, held: 0, scan: null, progress: [0, 0], paused: false, busy: false, pending: 0 });

      // Never scan a sandbox against a folder that is not its own worktree.
      const before = workspace.check(name, eng.state.size > 0);
      if (before) {
        block(name, before);
        return "blocked";
      }
      try {
        const result = await scan(eng, (done, total) => update(name, { progress: [done, total] }));
        const after = workspace.check(name, eng.state.size > 0);
        if (after) {
          block(name, after);
          return "blocked";
        }
        const needsReview = !!workspace.pair(name).entry?.needsReview;
        if (result.clean) {
          for (const s of result.statuses) eng.record(s.canonical);
          eng.flush();
          workspace.markReviewed(name);
          info(`проект и песочница совпадают (${result.statuses.length} файлов)`, name);
          await startLive(name, eng, [], massDeleteGuard);
          return "live";
        }
        const fillEmpty = result.sandboxFiles === 0 && result.projectFiles > 0 && result.pathErrors.length === 0;
        const smart = summarize(planReconcile(result, "smart"));
        const oneSided =
          eng.state.size > 0 && !needsReview && smart.user === 0 && smart.deleteProject === 0 && smart.deleteSandbox === 0;
        if (fillEmpty || oneSided) {
          update(name, { phase: "applying" });
          const strategy: Strategy = fillEmpty ? "project-wins" : "smart";
          const outcome = await applyReconcile(eng, planReconcile(result, strategy), (d, t) =>
            update(name, { progress: [d, t] })
          );
          reportOutcome(name, eng, outcome, fillEmpty ? "песочница заполнена" : "автосверка");
          if (fillEmpty) {
            workspace.markReviewed(name);
          }
          await startLive(name, eng, outcome.held, massDeleteGuard);
          return "live";
        }
        update(name, { phase: "review", scan: result, needsReview });
        return "review";
      } catch (e) {
        error((e as Error).message, name);
        block(name, { code: "io-error", message: (e as Error).message });
        return "blocked";
      }
    },
    [workspace, stopPair, update, block, info, error, reportOutcome, startLive]
  );

  // Start-up: refuse unsafe registries, then bring every pair up in turn.
  useEffect(() => {
    void (async () => {
      const problems = workspace.problems();
      if (problems.length > 0) {
        setFatal(problems.join("\n"));
        return;
      }
      for (const p of workspace.pairs()) {
        await bringUp(p.name);
      }
    })();
    // Run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyReview = useCallback(
    (name: string, strategy: Strategy) => {
      const eng = engines.current.get(name);
      const result = pairs.find((p) => p.name === name)?.scan;
      setScreen({ kind: "overview" });
      if (!eng || !result) return;
      const problem = workspace.check(name, eng.state.size > 0);
      if (problem) {
        block(name, problem);
        return;
      }
      update(name, { phase: "applying", progress: [0, 0] });
      void applyReconcile(eng, planReconcile(result, strategy), (d, t) => update(name, { progress: [d, t] }))
        .then(async (outcome) => {
          reportOutcome(name, eng, outcome, "сверка");
          workspace.markReviewed(name);
          syncList();
          await startLive(name, eng, outcome.held);
        })
        .catch((e) => {
          error((e as Error).message, name);
          block(name, { code: "io-error", message: (e as Error).message });
        });
    },
    [pairs, workspace, block, update, reportOutcome, syncList, startLive, error]
  );

  /** Why a pair cannot take part in a merge right now (null when it can). */
  const settled = useCallback((name: string): string | null => {
    const s = syncers.current.get(name);
    if (!s) return "синхронизация не запущена — сначала сверка или исправление проблемы";
    if (s.getProblem()) return s.getProblem()!.message;
    const held = s.getHeld().length;
    if (held > 0) return `${held} ${plural(held, "файл ждёт", "файла ждут", "файлов ждут")} решения`;
    if (s.isPaused()) return "на паузе (p)";
    if (!s.isIdle()) return "ещё синхронизируется — подождите";
    return null;
  }, []);

  /** Run an action; errors become a failed result (and a log line). */
  const attempt = useCallback(
    (action: () => ActionResult, pair?: string): ActionResult => {
      try {
        return action();
      } catch (e) {
        error((e as Error).message, pair);
        return { ok: false, lines: [(e as Error).message] };
      }
    },
    [error]
  );

  const describeMerge = useCallback(
    (outcome: MergeOutcome): ActionResult => {
      const t = outcome.target;
      for (const name of outcome.merged) {
        info(`слито в «${t}»: ${name}`, t);
      }
      if (outcome.leaks.length > 0) {
        warn(`возможная утечка в заметках слияния: ${outcome.leaks.join(", ")}`, t);
      }
      if (outcome.stoppedAt) {
        const n = outcome.conflicts.length;
        warn(`слияние ${outcome.stoppedAt} в «${t}»: конфликт в ${n} ${plural(n, "файле", "файлах", "файлах")}`, t);
        syncList();
        return {
          ok: true,
          lines: [
            `${outcome.merged.length ? `слито: ${outcome.merged.join(", ")}; ` : ""}конфликт при слиянии ${outcome.stoppedAt}: ${n} ${plural(n, "файл", "файла", "файлов")}`,
            `Скажите агенту в «${t}»: разреши конфликты слияния по .anonymus-merge/CONFLICTS.txt, собери и проверь.`,
            "Когда маркеров не останется и всё синхронизируется — k (продолжить), a — прервать.",
          ],
        };
      }
      syncList();
      const branch = workspace.pair(t).branch;
      info(`слияние в «${t}» завершено`, t);
      return {
        ok: true,
        lines: [
          `слияние в «${t}» завершено${outcome.merged.length ? `: ${outcome.merged.join(", ")}` : ""}`,
          `в main — в основной папке проекта: git merge --squash ${branch}`,
        ],
      };
    },
    [info, warn, syncList, workspace]
  );

  const createPair = useCallback(
    async (name: string, from: string): Promise<ActionResult> => {
      let entryInfo: ActionResult;
      try {
        const entry = workspace.create(name, { from }, (m) => info(m, name), (m) => warn(m, name));
        syncList();
        entryInfo = {
          ok: true,
          lines: [
            `«${name}» создана${entry.base ? ` от ${entry.base.branch}` : ""}`,
            `worktree ${entry.worktree}`,
            `песочница ${entry.sandbox} — агента можно запускать`,
          ],
        };
      } catch (e) {
        error((e as Error).message, name);
        return { ok: false, lines: [(e as Error).message] };
      }
      await bringUp(name);
      return entryInfo;
    },
    [workspace, info, warn, error, syncList, bringUp]
  );

  const removePair = useCallback(
    async (name: string, force: boolean): Promise<ActionResult> => {
      await stopPair(name);
      try {
        const { trashDir, warnings: w } = workspace.remove(name, { force }, (m) => info(m, name));
        w.forEach((m) => warn(m, name));
        engines.current.delete(name);
        syncList();
        info(`подпесочница удалена (корзина: ${path.relative(workspace.config.projectRoot, trashDir)}), ветка оставлена`, name);
        return { ok: true, lines: [`«${name}» удалена, песочница в корзине, ветка осталась`, ...w] };
      } catch (e) {
        error((e as Error).message, name);
        void bringUp(name);
        return { ok: false, lines: [(e as Error).message] };
      }
    },
    [workspace, stopPair, info, warn, error, syncList, bringUp]
  );

  const onProblemAction = useCallback(
    async (name: string, action: ProblemAction) => {
      setScreen({ kind: "overview" });
      if (action === "remove") {
        await removePair(name, false);
        return;
      }
      await stopPair(name);
      try {
        if (action === "recreate") {
          workspace.recreateWorktree(name, (m) => info(m, name), (m) => warn(m, name));
        } else if (action === "relink") {
          workspace.relink(name);
          info("worktree привязан заново", name);
        } else if (action === "relocate") {
          info(`worktree теперь в ${workspace.relocate(name)}`, name);
        } else if (action === "checkout") {
          workspace.checkoutBack(name);
          info(`в worktree снова ветка ${workspace.pair(name).branch}`, name);
        } else if (action === "refill") {
          workspace.refillSandbox(name);
        }
      } catch (e) {
        error((e as Error).message, name);
      }
      syncList();
      const phase = await bringUp(name);
      if (phase === "review") {
        setScreen({ kind: "reconcile", pair: name });
      } else if (phase === "blocked") {
        setScreen({ kind: "problem", pair: name });
      }
    },
    [workspace, stopPair, removePair, info, warn, error, syncList, bringUp]
  );

  const openPair = useCallback(
    (name: string) => {
      const p = pairs.find((x) => x.name === name);
      if (!p) return;
      if (p.phase === "review") setScreen({ kind: "reconcile", pair: name });
      else if (p.phase === "blocked") setScreen({ kind: "problem", pair: name });
      else if (p.phase === "live") setScreen({ kind: "conflicts", pair: name });
    },
    [pairs]
  );

  const quit = useCallback(() => {
    setScreen({ kind: "stopping" });
    void Promise.all([...syncers.current.keys()].map((n) => stopPair(n))).finally(() => exit());
  }, [exit, stopPair]);

  // Ctrl-C always stops cleanly (state saved), whatever screen is shown.
  useInput((input, key) => {
    if (key.ctrl && input === "c" && screen.kind !== "stopping") {
      quit();
    }
  });

  const summary: PairsSummary = {
    total: pairs.length,
    attention: pairs.filter(needsAttention).length,
    git: workspace.gitEnabled,
  };

  // One row is left free: a frame as tall as the window would scroll it.
  const frameRows = Math.max(5, rows - 1);
  const bodyMin = screen.kind === "reconcile" ? RECONCILE_COMPACT_ROWS : 10;
  // The mascot header stays as long as the window has room for it; a small
  // window gets the one-line header instead.
  const fullHeader = columns >= HEADER_MIN_COLUMNS && frameRows >= HEADER_ROWS + bodyMin;
  const bodyRows = frameRows - (fullHeader ? HEADER_ROWS : 1);
  const current = screen.kind !== "overview" && screen.kind !== "stopping" ? pairs.find((p) => p.name === screen.pair) : undefined;
  const maxItems = Math.max(1, Math.min(Math.max(pairs.length, 1), Math.floor(bodyRows / 3)));

  return (
    <Box flexDirection="column" height={frameRows} width={columns} overflow="hidden">
      {fullHeader ? (
        <Header config={workspace.config} version={version} summary={summary} />
      ) : (
        <CompactHeader config={workspace.config} version={version} summary={summary} />
      )}

      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {fatal && (
          <Box flexDirection="column">
            <Text color={theme.error}>Синхронизация не запущена — небезопасная настройка подпесочниц:</Text>
            {fatal.split("\n").map((l, i) => (
              <Text key={i} color={theme.error}>
                {"  "}- {l}
              </Text>
            ))}
            <Text color={theme.muted}>Исправьте .anonymus/sandboxes.json или anonymus.yaml и запустите снова. q — выход.</Text>
            <FatalKeys onQuit={() => exit()} />
          </Box>
        )}

        {!fatal && screen.kind === "overview" && (
          <PairsView
            workspace={workspace}
            pairs={pairs}
            events={events}
            maxItems={maxItems}
            rows={bodyRows}
            logPath={journal}
            onOpen={openPair}
            onConflicts={(name) => {
              if (syncers.current.has(name)) setScreen({ kind: "conflicts", pair: name });
            }}
            onCreate={createPair}
            onRemove={removePair}
            onMerge={(target, sources) =>
              attempt(() => describeMerge(startMerge(workspace, target, sources, settled)), target)
            }
            onContinueMerge={(target) => attempt(() => describeMerge(continueMerge(workspace, target, settled)), target)}
            onAbortMerge={(target) =>
              attempt(() => {
                abortMerge(workspace, target);
                syncList();
                info("слияние прервано (git merge --abort)", target);
                return { ok: true, lines: [`слияние в «${target}» прервано, worktree вернулся к состоянию до него`] };
              }, target)
            }
            onCommit={(name, message) =>
              attempt(() => {
                if (!workspace.commit(name, message)) {
                  return { ok: false, lines: ["нечего коммитить — незакоммиченных изменений нет"] };
                }
                info(`коммит: ${message}`, name);
                return { ok: true, lines: [`закоммичено в ${workspace.pair(name).branch}: ${message}`] };
              }, name)
            }
            onPause={(name) => {
              const s = syncers.current.get(name);
              if (s) s.isPaused() ? s.resume() : s.pause();
            }}
            onRescan={(name) => {
              const s = syncers.current.get(name);
              if (s) {
                info("пересканирую обе стороны…", name);
                s.rescan();
              } else {
                void bringUp(name);
              }
            }}
            onTrash={() => openFolder(path.join(workspace.config.projectRoot, SERVICE_DIR, "trash"))}
            onQuit={quit}
          />
        )}

        {!fatal && screen.kind === "reconcile" && current?.scan && (
          <ReconcileView
            key={current.name}
            scan={current.scan}
            hasHistory={(engines.current.get(current.name)?.state.size ?? 0) > 0}
            compact={bodyRows < RECONCILE_FULL_ROWS}
            pair={workspace.gitEnabled ? current.name : undefined}
            recommended={current.needsReview ? "sandbox-wins" : undefined}
            note={current.needsReview ? REVIEW_NOTE : undefined}
            onApply={(strategy) => applyReview(current.name, strategy)}
            onQuit={() => setScreen({ kind: "overview" })}
          />
        )}

        {!fatal && screen.kind === "conflicts" && current && syncers.current.get(current.name) && (
          <ConflictView
            held={heldFiles[current.name] ?? []}
            maxItems={Math.max(3, bodyRows - 12)}
            onResolve={(c, how) => syncers.current.get(current.name)!.resolve(c, how)}
            onBack={() => setScreen({ kind: "overview" })}
          />
        )}

        {!fatal && screen.kind === "problem" && current?.problem && (
          <ProblemView
            pair={workspace.pair(current.name)}
            problem={current.problem}
            movedTo={safely(() => workspace.movedTo(current.name))}
            onAction={(action) => void onProblemAction(current.name, action)}
            onBack={() => setScreen({ kind: "overview" })}
          />
        )}

        {screen.kind === "stopping" && <Text color={theme.muted}>останавливаю синхронизацию, сохраняю состояние…</Text>}
      </Box>
    </Box>
  );
}

function FatalKeys({ onQuit }: { onQuit: () => void }) {
  useInput((input) => {
    if (input === "q" || input === "й") onQuit();
  });
  return null;
}

function safely<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}
