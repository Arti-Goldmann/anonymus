import { useState } from "react";
import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import type { FileStatus } from "../core/engine.js";
import { KIND_LABEL } from "../core/scanner.js";
import type { Resolution } from "../core/syncer.js";
import { theme } from "./theme.js";

/**
 * Files held for a human decision. For the selected file the user keeps the
 * project version, keeps the sandbox version, or merges in VS Code.
 */
export function ConflictView({
  held,
  maxItems,
  onResolve,
  onBack,
}: {
  held: FileStatus[];
  /** How many files fit on screen; the list scrolls around the selection. */
  maxItems: number;
  onResolve: (canonical: string, how: Resolution) => Promise<{ ok: boolean; message: string }>;
  onBack: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const selected = held[Math.min(index, held.length - 1)];
  // Keep the selected row inside the visible window of the list.
  const first = Math.max(0, Math.min(index - Math.floor(maxItems / 2), held.length - maxItems));

  const run = (how: Resolution, label: string) => {
    if (!selected || busy) {
      return;
    }
    setBusy(label);
    setMessage(null);
    void onResolve(selected.canonical, how).then((r) => {
      setBusy(null);
      setMessage({ ok: r.ok, text: r.ok ? `${selected.canonical}: ${label}` : r.message });
      setIndex((i) => Math.max(0, Math.min(i, held.length - 2)));
    });
  };

  useInput((input, key) => {
    if (busy) {
      return;
    }
    if (key.escape || input === "q" || input === "й") {
      onBack();
    } else if (key.upArrow) {
      setIndex((i) => Math.max(0, i - 1));
    } else if (key.downArrow) {
      setIndex((i) => Math.min(held.length - 1, i + 1));
    } else if (input === "p" || input === "з") {
      run("project", "оставлена версия проекта");
    } else if (input === "s" || input === "ы") {
      run("sandbox", "оставлена версия песочницы");
    } else if (input === "m" || input === "ь") {
      run("editor", "слито в VS Code");
    }
  });

  if (held.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.ok} paddingX={1}>
        <Text color={theme.ok}>✓ Решений не требуется — все файлы синхронизируются.</Text>
        {message && <Text color={message.ok ? theme.ok : theme.error}>{message.text}</Text>}
        <Text color={theme.muted}>Esc назад</Text>
      </Box>
    );
  }

  const canMerge = selected && !selected.binary && !selected.deletedOn &&
    !["only-project", "only-sandbox", "deleted-in-project", "deleted-in-sandbox"].includes(selected.kind);

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={theme.error} paddingX={1} flexDirection="column">
        <Text bold>Ждут решения: {held.length}</Text>
        <Box flexDirection="column" marginTop={1}>
          {held.slice(first, first + maxItems).map((h, j) => {
            const i = first + j;
            return (
            <Text key={h.canonical} color={i === index ? theme.accent : undefined} wrap="truncate-middle">
              {i === index ? "❯ " : "  "}
              {h.canonical}
              <Text color={theme.muted}>  {describe(h)}</Text>
            </Text>
            );
          })}
          {held.length > maxItems && (
            <Text color={theme.muted}>
              {"  "}показаны {first + 1}–{Math.min(held.length, first + maxItems)} из {held.length}
            </Text>
          )}
        </Box>
      </Box>

      {selected && (
        <Box flexDirection="column" paddingX={1} marginTop={1}>
          <Text>
            <Text color={theme.project}>проект    </Text>
            {selected.projectPath}
          </Text>
          <Text>
            <Text color={theme.sandbox}>песочница </Text>
            {selected.sandboxPath}
          </Text>
        </Box>
      )}

      <Box marginTop={1} paddingX={1} flexDirection="column">
        {busy ? (
          <Text color={theme.accent}>
            <Spinner type="dots" />{" "}
            {busy === "слито в VS Code"
              ? "открыт merge editor VS Code — сохраните результат и закройте вкладку…"
              : "применяю…"}
          </Text>
        ) : (
          <Text>
            <Text color={theme.accent}>p</Text> взять проект · <Text color={theme.accent}>s</Text> взять песочницу
            {canMerge ? (
              <Text>
                {" "}· <Text color={theme.accent}>m</Text> слить в VS Code
              </Text>
            ) : null}
            <Text color={theme.muted}> · ↑↓ выбрать · Esc назад</Text>
          </Text>
        )}
        {message && <Text color={message.ok ? theme.ok : theme.error}>{message.text}</Text>}
      </Box>
    </Box>
  );
}

function describe(s: FileStatus): string {
  if (s.deletedOn) {
    return s.deletedOn === "project"
      ? "удалён в проекте, изменён в песочнице"
      : "удалён в песочнице, изменён в проекте";
  }
  return KIND_LABEL[s.kind];
}
