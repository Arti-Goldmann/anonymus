import * as fs from "node:fs";
import * as path from "node:path";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import { SERVICE_DIR } from "../config/schema.js";
import type { FileStatus, SyncEngine } from "../core/engine.js";
import { applyReconcile, planReconcile, summarize, type Strategy } from "../core/reconcile.js";
import { scan, type ScanResult } from "../core/scanner.js";
import { Syncer, type SyncEvent } from "../core/syncer.js";
import type { Workspace } from "../core/workspace.js";
import { openFolder } from "../platform.js";
import { ConflictView } from "./ConflictView.js";
import { CompactHeader, Header, HEADER_MIN_COLUMNS, HEADER_ROWS } from "./Header.js";
import { LIVE_CHROME_ROWS, LiveView, type LiveStatus } from "./LiveView.js";
import { RECONCILE_COMPACT_ROWS, RECONCILE_FULL_ROWS, ReconcileView } from "./ReconcileView.js";
import { SandboxesView, type ActionResult } from "./SandboxesView.js";
import { prepareMerge } from "../core/mergePrep.js";
import { formatTime, theme } from "./theme.js";
import { useTerminalSize } from "./useTerminalSize.js";

type Screen =
  | "scanning"
  | "reconcile"
  | "applying"
  | "switching"
  | "live"
  | "conflicts"
  | "sandboxes"
  | "stopping";

/** Screens of the start-up flow: the mascot is always shown here. */
const STARTUP_SCREENS: Screen[] = ["scanning", "reconcile", "applying", "switching"];

/** Live-sync events that mean a file actually moved; the first one folds the mascot. */
const TRANSFER_KINDS = new Set<SyncEvent["kind"]>(["to-sandbox", "to-project", "deleted", "merged", "resolved"]);

/** Events kept in memory for the on-screen log (the journal file has all). */
const MAX_EVENTS = 500;

const now = () => new Date();

/**
 * Root component. The whole UI is one frame exactly as tall as the window
 * (drawn on the terminal's alternate screen, see cli.tsx), so resizing just
 * redraws the frame — nothing is left behind in the scrollback.
 *
 * The workspace holds all sub-sandboxes; `engine` is the active one. A profile
 * goes through: scan → (reconcile screen | automatic reconcile) → live sync.
 * Switching stops the syncer, switches the git branch and starts over.
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
  const [engine, setEngine] = useState<SyncEngine>(() => workspace.engineFor());
  const engineRef = useRef(engine);
  const [screen, setScreen] = useState<Screen>("scanning");
  const [progress, setProgress] = useState<[number, number]>([0, 0]);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [steps, setSteps] = useState<string[]>([]);
  const [events, setEvents] = useState<SyncEvent[]>(() =>
    warnings.map((w) => ({ time: now(), kind: "warning" as const, message: w }))
  );
  const [held, setHeld] = useState<FileStatus[]>([]);
  const [status, setStatus] = useState<LiveStatus>({ paused: false, busy: false, pending: 0 });
  const [stats, setStats] = useState({ toSandbox: 0, toProject: 0, deleted: 0 });
  const [fatal, setFatal] = useState<string | null>(null);
  // The mascot stays on the live screen until the first file moves.
  const [folded, setFolded] = useState(false);
  const syncerRef = useRef<Syncer | null>(null);
  const journal = useMemo(() => path.join(workspace.config.projectRoot, SERVICE_DIR, "anonymus.log"), [workspace]);

  const pushEvent = useCallback(
    (ev: SyncEvent) => {
      setEvents((prev) => [...prev.slice(-(MAX_EVENTS - 1)), ev]);
      if (TRANSFER_KINDS.has(ev.kind)) {
        setFolded(true);
      }
      if (ev.kind === "to-sandbox" || ev.kind === "to-project" || ev.kind === "deleted") {
        setStats((s) => ({
          toSandbox: s.toSandbox + (ev.kind === "to-sandbox" ? 1 : 0),
          toProject: s.toProject + (ev.kind === "to-project" ? 1 : 0),
          deleted: s.deleted + (ev.kind === "deleted" ? 1 : 0),
        }));
      }
      try {
        fs.mkdirSync(path.dirname(journal), { recursive: true });
        const date = ev.time.toISOString().slice(0, 10);
        const profile = engineRef.current.config.profile.name;
        fs.appendFileSync(
          journal,
          `${date} ${formatTime(ev.time)}  [${profile}] ${ev.kind.padEnd(10)} ${ev.message}\n`,
          "utf8"
        );
      } catch {
        // The journal is a convenience; never break syncing over it.
      }
    },
    [journal]
  );
  const info = useCallback((message: string) => pushEvent({ time: now(), kind: "info", message }), [pushEvent]);
  const warn = useCallback((message: string) => pushEvent({ time: now(), kind: "warning", message }), [pushEvent]);

  const startLive = useCallback(
    async (eng: SyncEngine, initiallyHeld: FileStatus[]) => {
      const syncer = new Syncer(eng, initiallyHeld);
      syncerRef.current = syncer;
      syncer.on("event", pushEvent);
      syncer.on("held", setHeld);
      syncer.on("state", setStatus);
      setHeld(syncer.getHeld());
      setScreen("live");
      await syncer.start();
    },
    [pushEvent]
  );

  const reportOutcome = useCallback(
    (eng: SyncEngine, outcome: Awaited<ReturnType<typeof applyReconcile>>, label: string) => {
      info(
        `${label}: в песочницу ${outcome.transfers.filter((t) => t.to === "sandbox").length}, ` +
          `в проект ${outcome.transfers.filter((t) => t.to === "project").length}, ` +
          `удалено ${outcome.deleted}, слито ${outcome.merged}, на решение ${outcome.held.length}`
      );
      for (const t of outcome.transfers) {
        if (t.leaks.length > 0) {
          warn(`возможная утечка в ${eng.mapper.toSandbox(t.canonical)}: ${t.leaks.join(", ")}`);
        }
      }
      for (const f of outcome.failures) {
        pushEvent({ time: now(), kind: "error", message: `${f.status.canonical}: ${f.error}` });
      }
    },
    [info, warn, pushEvent]
  );

  /**
   * Bring one sub-sandbox up: scan, then reconcile — automatically when it is
   * unambiguous (an empty sandbox to fill, or only one-sided changes since the
   * last sync), otherwise on the reconcile screen — and start live sync.
   */
  const startProfile = useCallback(
    async (eng: SyncEngine) => {
      engineRef.current = eng;
      setEngine(eng);
      setScanResult(null);
      setHeld([]);
      setStats({ toSandbox: 0, toProject: 0, deleted: 0 });
      setProgress([0, 0]);
      setFolded(false);
      setScreen("scanning");
      try {
        const result = await scan(eng, (done, total) => setProgress([done, total]));
        if (result.clean) {
          for (const s of result.statuses) eng.record(s.canonical);
          eng.flush();
          info(`«${eng.config.profile.name}»: проект и песочница совпадают (${result.statuses.length} файлов)`);
          return startLive(eng, []);
        }

        const fillEmpty = result.sandboxFiles === 0 && result.projectFiles > 0 && result.pathErrors.length === 0;
        const smart = summarize(planReconcile(result, "smart"));
        const oneSided =
          eng.state.size > 0 &&
          !workspace.branchMismatch &&
          smart.user === 0 &&
          smart.deleteProject === 0 &&
          smart.deleteSandbox === 0;
        if (fillEmpty || oneSided) {
          const strategy: Strategy = fillEmpty ? "project-wins" : "smart";
          setScreen("applying");
          const outcome = await applyReconcile(eng, planReconcile(result, strategy), (d, t) => setProgress([d, t]));
          reportOutcome(eng, outcome, fillEmpty ? "песочница заполнена" : "автосверка");
          return startLive(eng, outcome.held);
        }
        setScanResult(result);
        setScreen("reconcile");
      } catch (e) {
        setFatal((e as Error).message);
      }
    },
    [workspace, info, reportOutcome, startLive]
  );

  // Start-up: align the active sub-sandbox with the checked-out branch, then go.
  useEffect(() => {
    for (const n of workspace.reconcileWithGit()) {
      pushEvent({ time: now(), kind: n.kind, message: n.message });
    }
    void startProfile(workspace.engineFor());
    // Run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const apply = useCallback(
    (strategy: Strategy) => {
      const eng = engineRef.current;
      if (!scanResult) return;
      setScreen("applying");
      setProgress([0, 0]);
      applyReconcile(eng, planReconcile(scanResult, strategy), (d, t) => setProgress([d, t]))
        .then((outcome) => {
          reportOutcome(eng, outcome, "сверка");
          return startLive(eng, outcome.held);
        })
        .catch((e) => setFatal((e as Error).message));
    },
    [scanResult, reportOutcome, startLive]
  );

  const stopSyncer = useCallback(async () => {
    const s = syncerRef.current;
    syncerRef.current = null;
    if (s) {
      s.removeAllListeners();
      await s.stop();
    }
  }, []);

  /** Stop syncing, run a branch operation, then bring the new active profile up. */
  const runSwitch = useCallback(
    async (title: string, operation: (step: (m: string) => void) => string[]) => {
      setScreen("switching");
      setSteps([title]);
      await stopSyncer();
      // Let the screen show before git (synchronous) runs.
      await new Promise((r) => setTimeout(r, 30));
      try {
        const opWarnings = operation((m) => setSteps((s) => [...s, m]));
        opWarnings.forEach(warn);
        const active = workspace.active;
        info(`активна «${active.name}»${active.branch ? ` ⎇ ${active.branch}` : ""}`);
      } catch (e) {
        pushEvent({ time: now(), kind: "error", message: (e as Error).message });
      }
      await startProfile(workspace.engineFor());
    },
    [stopSyncer, workspace, warn, info, pushEvent, startProfile]
  );

  const switchTo = useCallback(
    (name: string) => void runSwitch(`переключаюсь на «${name}»`, (step) => workspace.switchTo(name, step)),
    [runSwitch, workspace]
  );
  /** Run a sub-sandbox action that does not switch branches; errors become a result. */
  const attempt = useCallback(
    (action: () => ActionResult): ActionResult => {
      try {
        return action();
      } catch (e) {
        pushEvent({ time: now(), kind: "error", message: (e as Error).message });
        return { ok: false, lines: [(e as Error).message] };
      }
    },
    [pushEvent]
  );

  const createSandbox = useCallback(
    (name: string, from: string, switchToIt: boolean): ActionResult | void => {
      if (switchToIt) {
        void runSwitch(`создаю подпесочницу «${name}» от ${from}`, (step) =>
          workspace.create(name, { from, switchTo: true }, step).warnings
        );
        return;
      }
      // The project stays on its branch: the new sub-sandbox is filled from git.
      return attempt(() => {
        const { entry, filled } = workspace.create(name, { from, switchTo: false });
        const folder = workspace.registry.absPath(entry);
        info(`создана подпесочница «${name}» ⎇ ${name} от ${from}: ${filled} файлов в ${folder}`);
        return { ok: true, lines: [`«${name}» создана от ${from}: ${filled} файлов`, `папка ${folder} — агента можно запускать`] };
      });
    },
    [runSwitch, workspace, attempt, info]
  );
  const removeSandbox = useCallback(
    (name: string, dropStash: boolean): ActionResult =>
      attempt(() => {
        const { trashDir, warnings: w, stashDropped } = workspace.remove(name, () => {}, { dropStash });
        w.forEach(warn);
        const stashNote = stashDropped ? ", её stash удалён" : "";
        info(
          `подпесочница «${name}» удалена (папка в ${path.relative(workspace.config.projectRoot, trashDir)}), ` +
            `ветка оставлена${stashNote}`
        );
        return { ok: true, lines: [`«${name}» удалена, папка в корзине${stashNote}`, ...w] };
      }),
    [workspace, attempt, warn, info]
  );
  const prepareMergeInto = useCallback(
    (target: string, sources: string[]): ActionResult =>
      attempt(() => {
        const { dir, sources: results } = prepareMerge(workspace, target, sources);
        const lines = results.map(
          (r) =>
            `${r.name}: изменено ${r.modified}, добавлено ${r.added}, удалено ${r.deleted}` +
            (r.binary ? `, бинарных ${r.binary}` : "") +
            (r.leaks.length ? ` — ⚠ утечка: ${r.leaks.join(", ")}` : "")
        );
        for (const r of results) {
          if (r.leaks.length) warn(`возможная утечка в ${r.patch}: ${r.leaks.join(", ")}`);
        }
        info(`подготовлено слияние в «${target}»: ${sources.join(", ")}`);
        return {
          ok: true,
          lines: [
            `Патчи готовы: ${dir}`,
            ...lines,
            `Скажите агенту в «${target}» применить .anonymus-merge/*.patch; потом k — закоммитить итог.`,
          ],
        };
      }),
    [workspace, attempt, warn, info]
  );
  const commitActive = useCallback(
    (message: string): ActionResult =>
      attempt(() => {
        const branch = workspace.active.branch;
        if (!workspace.commitActive(message)) {
          return { ok: false, lines: ["нечего коммитить — незакоммиченных изменений нет"] };
        }
        info(`коммит в ${branch}: ${message}`);
        return { ok: true, lines: [`закоммичено в ${branch}: ${message}`, `в main: git checkout main && git merge ${branch}`] };
      }),
    [workspace, attempt, info]
  );

  const quit = useCallback(() => {
    setScreen("stopping");
    void stopSyncer().finally(() => exit());
  }, [exit, stopSyncer]);

  // Ctrl-C always stops cleanly (state saved), whatever screen is shown.
  useInput((input, key) => {
    if (key.ctrl && input === "c" && screen !== "stopping") {
      quit();
    }
  });

  useInput(
    (input) => {
      const s = syncerRef.current;
      if (input === "q" || input === "й") {
        quit();
      } else if ((input === "c" || input === "с") && s) {
        setScreen("conflicts");
      } else if (input === "b" || input === "и") {
        setScreen("sandboxes");
      } else if ((input === "p" || input === "з") && s) {
        s.isPaused() ? s.resume() : s.pause();
      } else if ((input === "r" || input === "к") && s) {
        info("пересканирую обе стороны…");
        s.rescan();
      } else if (input === "o" || input === "щ") {
        openFolder(engine.trash.root);
      }
    },
    { isActive: screen === "live" }
  );

  // One row is left free: a frame as tall as the window would scroll it.
  const frameRows = Math.max(5, rows - 1);
  // The mascot greets during start-up and stays on the live screen until the
  // first file moves; then it folds into a one-line header and the log gets
  // the space. Conflict and sub-sandbox screens always use the compact header.
  const bodyMin =
    screen === "reconcile"
      ? RECONCILE_COMPACT_ROWS
      : screen === "switching"
        ? 6
        : screen === "live"
          ? LIVE_CHROME_ROWS + 3
          : 2;
  const showMascot = STARTUP_SCREENS.includes(screen) || (screen === "live" && !folded);
  const fullHeader = showMascot && columns >= HEADER_MIN_COLUMNS && frameRows >= HEADER_ROWS + bodyMin;
  const bodyRows = frameRows - (fullHeader ? HEADER_ROWS : 1);

  return (
    <Box flexDirection="column" height={frameRows} width={columns} overflow="hidden">
      {fullHeader ? (
        <Header config={engine.config} version={version} />
      ) : (
        <CompactHeader config={engine.config} version={version} />
      )}

      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {fatal && <Text color={theme.error}>Ошибка: {fatal}</Text>}

        {!fatal && (screen === "scanning" || screen === "applying") && (
          <Text color={theme.accent}>
            <Spinner type="dots" /> {screen === "scanning" ? "сравниваю проект и песочницу" : "применяю сверку"}
            <Text color={theme.muted}>{progress[1] > 0 ? `  ${progress[0]}/${progress[1]}` : ""}</Text>
          </Text>
        )}

        {!fatal && screen === "switching" && (
          <Box flexDirection="column">
            {steps.map((s, i) => (
              <Text key={i} color={i === steps.length - 1 ? theme.accent : theme.muted} wrap="truncate-end">
                {i === steps.length - 1 ? <Spinner type="dots" /> : "✓"} {s}
              </Text>
            ))}
          </Box>
        )}

        {!fatal && screen === "reconcile" && scanResult && (
          <ReconcileView
            scan={scanResult}
            hasHistory={engine.state.size > 0}
            compact={bodyRows < RECONCILE_FULL_ROWS}
            onApply={apply}
            onQuit={() => exit()}
          />
        )}

        {!fatal && screen === "live" && (
          <LiveView
            status={status}
            events={events}
            heldCount={held.length}
            stats={stats}
            logRows={bodyRows - LIVE_CHROME_ROWS}
            logPath={journal}
          />
        )}

        {!fatal && screen === "conflicts" && syncerRef.current && (
          <ConflictView
            held={held}
            maxItems={Math.max(3, bodyRows - 12)}
            onResolve={(c, how) => syncerRef.current!.resolve(c, how)}
            onBack={() => setScreen("live")}
          />
        )}

        {!fatal && screen === "sandboxes" && (
          <SandboxesView
            workspace={workspace}
            heldCount={held.length}
            maxItems={Math.max(3, bodyRows - 12)}
            onSwitch={switchTo}
            onCreate={createSandbox}
            onRemove={removeSandbox}
            onPrepareMerge={prepareMergeInto}
            onCommit={commitActive}
            onBack={() => setScreen("live")}
          />
        )}

        {screen === "stopping" && <Text color={theme.muted}>останавливаю синхронизацию, сохраняю состояние…</Text>}
      </Box>
    </Box>
  );
}
