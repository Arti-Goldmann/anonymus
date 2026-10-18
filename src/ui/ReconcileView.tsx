import { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { Kind } from "../core/engine.js";
import { planReconcile, summarize, type Strategy } from "../core/reconcile.js";
import { KIND_LABEL, type ScanResult } from "../core/scanner.js";
import { theme } from "./theme.js";

interface Option {
  key: string;
  strategy: Strategy;
  title: string;
  hint: string;
}

/** Rows the view needs to show everything (counts, menu with hints). */
export const RECONCILE_FULL_ROWS = 24;
/** Rows the compact variant needs (title, counts, bare menu). */
export const RECONCILE_COMPACT_ROWS = 10;

const KIND_ORDER: Kind[] = [
  "only-project",
  "only-sandbox",
  "project-changed",
  "sandbox-changed",
  "deleted-in-project",
  "deleted-in-sandbox",
  "both-changed",
  "differs-unknown",
  "error",
  "synced",
];

/**
 * Startup decision: shows how the two trees differ and lets the user pick
 * how to bring them in line before live sync starts. Two steps: choose a
 * strategy, then confirm the concrete plan (counts, deletions highlighted).
 */
export function ReconcileView({
  scan,
  hasHistory,
  compact,
  onApply,
  onQuit,
}: {
  scan: ScanResult;
  hasHistory: boolean;
  /** Small window: drop hints and spacing so the menu stays visible. */
  compact: boolean;
  onApply: (strategy: Strategy) => void;
  onQuit: () => void;
}) {
  const sandboxEmpty = scan.sandboxFiles === 0;
  const options: Option[] = useMemo(
    () => [
      {
        key: "1",
        strategy: "project-wins",
        title: "Проект → песочница",
        hint: sandboxEmpty
          ? "песочница пуста — заполнить её из проекта"
          : "песочница станет копией проекта, лишние файлы в ней будут удалены",
      },
      {
        key: "2",
        strategy: "sandbox-wins",
        title: "Песочница → проект",
        hint: "проект станет копией песочницы, лишние файлы в нём будут удалены",
      },
      {
        key: "3",
        strategy: "smart",
        title: "Умная сверка",
        hint: hasHistory
          ? "свежие изменения переносятся в обе стороны, правки с двух сторон сливаются"
          : "истории ещё нет: новые файлы переносятся, различия — на ручное решение",
      },
      {
        key: "4",
        strategy: "manual",
        title: "Разобрать по файлам",
        hint: "все различия попадут в список решений (клавиша c во время работы)",
      },
    ],
    [sandboxEmpty, hasHistory]
  );
  const defaultIndex = sandboxEmpty ? 0 : hasHistory ? 2 : 0;
  const [index, setIndex] = useState(defaultIndex);
  const [confirming, setConfirming] = useState<Strategy | null>(null);
  const [showFiles, setShowFiles] = useState(false);

  const plan = useMemo(() => (confirming ? summarize(planReconcile(scan, confirming)) : null), [scan, confirming]);

  useInput((input, key) => {
    if (confirming) {
      if (key.return || input === "y" || input === "д") {
        onApply(confirming);
      } else if (key.escape || input === "n" || input === "н") {
        setConfirming(null);
      }
      return;
    }
    if (input === "q" || input === "й") {
      onQuit();
    } else if (input === "d" || input === "в") {
      setShowFiles((v) => !v);
    } else if (key.upArrow) {
      setIndex((i) => (i + options.length - 1) % options.length);
    } else if (key.downArrow) {
      setIndex((i) => (i + 1) % options.length);
    } else if (key.return) {
      setConfirming(options[index].strategy);
    } else {
      const opt = options.find((o) => o.key === input);
      if (opt) {
        setIndex(options.indexOf(opt));
        setConfirming(opt.strategy);
      }
    }
  });

  const differing = scan.statuses.filter((s) => s.kind !== "synced");

  return (
    <Box flexDirection="column">
      <Box
        borderStyle={compact ? undefined : "round"}
        borderColor={theme.accent}
        paddingX={compact ? 0 : 1}
        flexDirection="column"
        flexShrink={0}
      >
        <Text bold wrap="truncate-end">
          Проект и песочница расходятся — нужно решить, прежде чем начать синхронизацию
        </Text>
        <Box marginTop={compact ? 0 : 1} flexDirection="column">
          {KIND_ORDER.filter((k) => scan.counts[k] > 0).map((k) => (
            <Text key={k}>
              <Text color={k === "synced" ? theme.ok : k === "error" || k === "both-changed" ? theme.error : theme.warn}>
                {String(scan.counts[k]).padStart(6)}
              </Text>
              {"  "}
              {KIND_LABEL[k]}
            </Text>
          ))}
          {scan.pathErrors.length > 0 && (
            <Text color={theme.error}>
              {String(scan.pathErrors.length).padStart(6)}  путей не сопоставить (не синхронизируются)
            </Text>
          )}
        </Box>
        {showFiles && (
          <Box marginTop={1} flexDirection="column">
            {differing.slice(0, compact ? 5 : 20).map((s) => (
              <Text key={s.canonical} wrap="truncate-middle">
                <Text color={theme.muted}>{KIND_LABEL[s.kind].padEnd(28)}</Text>
                {s.canonical}
              </Text>
            ))}
            {scan.pathErrors.slice(0, 5).map((e) => (
              <Text key={e.side + e.path} color={theme.error} wrap="truncate-end">
                {e.side === "project" ? "проект" : "песочница"} {e.path}: {e.problem}
              </Text>
            ))}
            {differing.length > (compact ? 5 : 20) && (
              <Text color={theme.muted}>… и ещё {differing.length - (compact ? 5 : 20)}</Text>
            )}
          </Box>
        )}
      </Box>

      {!confirming && (
        <Box flexDirection="column" marginTop={compact ? 0 : 1}>
          {options.map((o, i) => (
            <Box key={o.key} flexDirection="column">
              <Text color={i === index ? theme.accent : undefined} bold={i === index}>
                {i === index ? "❯ " : "  "}
                {o.key}. {o.title}
                {i === defaultIndex && <Text color={theme.muted}> (рекомендуется)</Text>}
              </Text>
              {!compact && (
                <Text color={theme.muted} wrap="truncate-end">
                  {"     "}
                  {o.hint}
                </Text>
              )}
            </Box>
          ))}
          <Box marginTop={compact ? 0 : 1}>
            <Text color={theme.muted} wrap="truncate-end">
              ↑↓ / 1–4 выбрать · Enter подтвердить · d список файлов · q выйти
            </Text>
          </Box>
        </Box>
      )}

      {confirming && plan && (
        <Box flexDirection="column" marginTop={compact ? 0 : 1} borderStyle={compact ? undefined : "round"} paddingX={1}>
          <Text bold>{options.find((o) => o.strategy === confirming)?.title}: что будет сделано</Text>
          <Text>  в песочницу:          {plan.toSandbox}</Text>
          <Text>  в проект:             {plan.toProject}</Text>
          <Text color={plan.deleteSandbox > 0 ? theme.warn : undefined}>  удалить в песочнице:  {plan.deleteSandbox}</Text>
          <Text color={plan.deleteProject > 0 ? theme.error : undefined}>  удалить в проекте:    {plan.deleteProject}</Text>
          <Text>  слить автоматически:  {plan.autoMerge}</Text>
          <Text>  на ручное решение:    {plan.user}</Text>
          <Text color={theme.muted}>Удаляемые и перезаписываемые файлы сохраняются в .anonymus/trash.</Text>
          <Text>
            <Text color={theme.accent}>Enter</Text> применить · <Text color={theme.accent}>Esc</Text> назад
          </Text>
        </Box>
      )}
    </Box>
  );
}
