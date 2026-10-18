import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { SyncEvent, SyncEventKind } from "../core/syncer.js";
import { formatTime, plural, theme } from "./theme.js";

const ICON: Record<SyncEventKind, { icon: string; color: string }> = {
  "to-sandbox": { icon: "→", color: theme.sandbox },
  "to-project": { icon: "←", color: theme.project },
  deleted: { icon: "✕", color: theme.warn },
  merged: { icon: "⇄", color: theme.ok },
  held: { icon: "!", color: theme.error },
  resolved: { icon: "✓", color: theme.ok },
  warning: { icon: "⚠", color: theme.warn },
  error: { icon: "✗", color: theme.error },
  info: { icon: "·", color: theme.muted },
};

/** One log line; always exactly one terminal row (long messages are cut). */
export function EventLine({ event }: { event: SyncEvent }) {
  const s = ICON[event.kind];
  const count = event.replacements
    ? `  (${event.replacements} ${plural(event.replacements, "замена", "замены", "замен")})`
    : "";
  return (
    <Text wrap="truncate-end">
      <Text color={theme.muted}>{formatTime(event.time)} </Text>
      <Text color={s.color}>{s.icon} </Text>
      <Text color={event.kind === "info" ? theme.muted : undefined}>{event.message}</Text>
      <Text color={theme.muted}>{count}</Text>
    </Text>
  );
}

export interface LiveStatus {
  paused: boolean;
  busy: boolean;
  pending: number;
}

/** Rows LiveView needs besides the log itself. */
export const LIVE_CHROME_ROWS = 5;

/** Main screen while syncing: status, recent activity, key hints. */
export function LiveView({
  status,
  events,
  heldCount,
  stats,
  logRows,
  logPath,
}: {
  status: LiveStatus;
  events: SyncEvent[];
  heldCount: number;
  stats: { toSandbox: number; toProject: number; deleted: number };
  logRows: number;
  logPath: string;
}) {
  const shown = events.slice(-Math.max(1, logRows));
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box borderStyle="round" borderColor={status.paused ? theme.warn : theme.accent} paddingX={1} flexShrink={0}>
        <Box flexGrow={1}>
          {status.paused ? (
            <Text color={theme.warn} wrap="truncate-end">⏸ пауза — изменения копятся до нажатия p</Text>
          ) : status.busy || status.pending > 0 ? (
            <Text color={theme.accent} wrap="truncate-end">
              <Spinner type="dots" /> синхронизирую{status.pending > 0 ? ` · в очереди ${status.pending}` : ""}
            </Text>
          ) : (
            <Text color={theme.ok} wrap="truncate-end">● синхронизация активна</Text>
          )}
        </Box>
        <Text color={theme.muted}>
          → {stats.toSandbox} · ← {stats.toProject} · ✕ {stats.deleted}
        </Text>
      </Box>

      <Box paddingX={1} flexShrink={0}>
        {heldCount > 0 ? (
          <Text color={theme.error} wrap="truncate-end">
            ! {heldCount} {plural(heldCount, "файл ждёт", "файла ждут", "файлов ждут")} решения — нажмите c
          </Text>
        ) : (
          <Text color={theme.muted} wrap="truncate-middle">журнал: {logPath}</Text>
        )}
      </Box>

      <Box flexDirection="column" paddingX={1} flexGrow={1} overflow="hidden">
        {shown.length === 0 ? (
          <Text color={theme.muted}>Пока тихо. Изменения появятся здесь.</Text>
        ) : (
          shown.map((e, i) => <EventLine key={i} event={e} />)
        )}
      </Box>

      <Box paddingX={1} flexShrink={0}>
        <Text color={theme.muted} wrap="truncate-end">
          c конфликты · p {status.paused ? "продолжить" : "пауза"} · r пересканировать · o корзина · q выход
        </Text>
      </Box>
    </Box>
  );
}
