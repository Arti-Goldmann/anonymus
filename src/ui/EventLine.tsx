import { Text } from "ink";
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
export function EventLine({ event, showPair = false }: { event: SyncEvent; showPair?: boolean }) {
  const s = ICON[event.kind];
  const count = event.replacements
    ? `  (${event.replacements} ${plural(event.replacements, "замена", "замены", "замен")})`
    : "";
  return (
    <Text wrap="truncate-end">
      <Text color={theme.muted}>{formatTime(event.time)} </Text>
      <Text color={s.color}>{s.icon} </Text>
      {showPair && event.pair && <Text color={theme.info}>[{event.pair}] </Text>}
      <Text color={event.kind === "info" ? theme.muted : undefined}>{event.message}</Text>
      <Text color={theme.muted}>{count}</Text>
    </Text>
  );
}
