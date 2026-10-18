import * as fs from "node:fs";
import * as path from "node:path";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import { SERVICE_DIR } from "../config/schema.js";
import type { FileStatus, SyncEngine } from "../core/engine.js";
import { applyReconcile, planReconcile, type Strategy } from "../core/reconcile.js";
import { scan, type ScanResult } from "../core/scanner.js";
import { Syncer, type SyncEvent } from "../core/syncer.js";
import { openFolder } from "../platform.js";
import { ConflictView } from "./ConflictView.js";
import { CompactHeader, Header, HEADER_MIN_COLUMNS, HEADER_ROWS } from "./Header.js";
import { LIVE_CHROME_ROWS, LiveView, type LiveStatus } from "./LiveView.js";
import { RECONCILE_COMPACT_ROWS, RECONCILE_FULL_ROWS, ReconcileView } from "./ReconcileView.js";
import { formatTime, theme } from "./theme.js";
import { useTerminalSize } from "./useTerminalSize.js";

type Screen = "scanning" | "reconcile" | "applying" | "live" | "conflicts" | "stopping";

/** Events kept in memory for the on-screen log (the journal file has all). */
const MAX_EVENTS = 500;

/**
 * Root component. The whole UI is one frame exactly as tall as the window
 * (drawn on the terminal's alternate screen, see cli.tsx), so resizing just
 * redraws the frame — nothing is left behind in the scrollback.
 */
export function App({
  engine,
  version,
  warnings,
}: {
  engine: SyncEngine;
  version: string;
  warnings: string[];
}) {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const [screen, setScreen] = useState<Screen>("scanning");
  const [progress, setProgress] = useState<[number, number]>([0, 0]);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [events, setEvents] = useState<SyncEvent[]>(() =>
    warnings.map((w) => ({ time: new Date(), kind: "warning" as const, message: w }))
  );
  const [held, setHeld] = useState<FileStatus[]>([]);
  const [status, setStatus] = useState<LiveStatus>({ paused: false, busy: false, pending: 0 });
  const [stats, setStats] = useState({ toSandbox: 0, toProject: 0, deleted: 0 });
  const [fatal, setFatal] = useState<string | null>(null);
  const syncerRef = useRef<Syncer | null>(null);
  const journal = useMemo(() => path.join(engine.projectRoot, SERVICE_DIR, "anonymus.log"), [engine]);

  const pushEvent = useCallback(
    (ev: SyncEvent) => {
      setEvents((prev) => [...prev.slice(-(MAX_EVENTS - 1)), ev]);
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
        fs.appendFileSync(journal, `${date} ${formatTime(ev.time)}  ${ev.kind.padEnd(10)} ${ev.message}\n`, "utf8");
      } catch {
        // The journal is a convenience; never break syncing over it.
      }
    },
    [journal]
  );

  const startLive = useCallback(
    async (initiallyHeld: FileStatus[]) => {
      const syncer = new Syncer(engine, initiallyHeld);
      syncerRef.current = syncer;
      syncer.on("event", pushEvent);
      syncer.on("held", setHeld);
      syncer.on("state", setStatus);
      setHeld(syncer.getHeld());
      setScreen("live");
      await syncer.start();
    },
    [engine, pushEvent]
  );

  // Startup scan.
  useEffect(() => {
    let cancelled = false;
    scan(engine, (done, total) => !cancelled && setProgress([done, total]))
      .then((result) => {
        if (cancelled) return;
        setScanResult(result);
        if (result.clean) {
          // Remember files that already match, so later changes are one-sided.
          for (const s of result.statuses) engine.record(s.canonical);
          engine.flush();
          pushEvent({
            time: new Date(),
            kind: "info",
            message: `проект и песочница совпадают (${result.statuses.length} файлов)`,
          });
          void startLive([]);
        } else {
          setScreen("reconcile");
        }
      })
      .catch((e) => setFatal((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [engine, pushEvent, startLive]);

  const apply = useCallback(
    (strategy: Strategy) => {
      if (!scanResult) return;
      setScreen("applying");
      setProgress([0, 0]);
      applyReconcile(engine, planReconcile(scanResult, strategy), (d, t) => setProgress([d, t]))
        .then((outcome) => {
          pushEvent({
            time: new Date(),
            kind: "info",
            message:
              `сверка: в песочницу ${outcome.transfers.filter((t) => t.to === "sandbox").length}, ` +
              `в проект ${outcome.transfers.filter((t) => t.to === "project").length}, ` +
              `удалено ${outcome.deleted}, слито ${outcome.merged}, на решение ${outcome.held.length}`,
          });
          for (const t of outcome.transfers) {
            if (t.leaks.length > 0) {
              pushEvent({
                time: new Date(),
                kind: "warning",
                message: `возможная утечка в ${engine.mapper.toSandbox(t.canonical)}: ${t.leaks.join(", ")}`,
              });
            }
          }
          for (const f of outcome.failures) {
            pushEvent({ time: new Date(), kind: "error", message: `${f.status.canonical}: ${f.error}` });
          }
          return startLive(outcome.held);
        })
        .catch((e) => setFatal((e as Error).message));
    },
    [engine, scanResult, pushEvent, startLive]
  );

  const quit = useCallback(() => {
    setScreen("stopping");
    const s = syncerRef.current;
    (s ? s.stop() : Promise.resolve()).finally(() => exit());
  }, [exit]);

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
      } else if ((input === "p" || input === "з") && s) {
        s.isPaused() ? s.resume() : s.pause();
      } else if ((input === "r" || input === "к") && s) {
        pushEvent({ time: new Date(), kind: "info", message: "пересканирую обе стороны…" });
        s.rescan();
      } else if (input === "o" || input === "щ") {
        openFolder(engine.trash.root);
      }
    },
    { isActive: screen === "live" }
  );

  // One row is left free: a frame as tall as the window would scroll it.
  const frameRows = Math.max(5, rows - 1);
  // The mascot is shown whenever the screen below it still fits (the menu
  // switches to its compact form); while syncing, log space wins.
  const bodyMin =
    screen === "live" || screen === "conflicts"
      ? LIVE_CHROME_ROWS + 8
      : screen === "reconcile"
        ? RECONCILE_COMPACT_ROWS
        : 2;
  const fullHeader = columns >= HEADER_MIN_COLUMNS && frameRows >= HEADER_ROWS + bodyMin;
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

        {screen === "stopping" && <Text color={theme.muted}>останавливаю синхронизацию, сохраняю состояние…</Text>}
      </Box>
    </Box>
  );
}
