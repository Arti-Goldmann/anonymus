import * as fs from "node:fs";
import * as path from "node:path";
import { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type { Workspace } from "../core/workspace.js";
import { plural, theme } from "./theme.js";

type Mode =
  | { kind: "list" }
  | { kind: "new"; value: string; error: string | null }
  | { kind: "confirm-delete"; name: string }
  | { kind: "confirm-switch"; name: string };

/**
 * Sub-sandboxes of the project: one per git branch. Switch (Enter), create a
 * new one for a new branch (n), remove an inactive one (d).
 */
export function SandboxesView({
  workspace,
  heldCount,
  maxItems,
  onSwitch,
  onCreate,
  onRemove,
  onBack,
}: {
  workspace: Workspace;
  heldCount: number;
  maxItems: number;
  onSwitch: (name: string) => void;
  onCreate: (name: string) => void;
  onRemove: (name: string) => { ok: boolean; message: string };
  onBack: () => void;
}) {
  const list = workspace.registry.list();
  const activeName = workspace.active.name;
  const [index, setIndex] = useState(() => Math.max(0, list.findIndex((s) => s.name === activeName)));
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const selected = list[Math.min(index, list.length - 1)];
  const first = Math.max(0, Math.min(index - Math.floor(maxItems / 2), list.length - maxItems));

  const requestSwitch = (name: string) => {
    if (name === activeName) {
      setMessage({ ok: true, text: `«${name}» уже активна` });
    } else if (heldCount > 0) {
      setMode({ kind: "confirm-switch", name });
    } else {
      onSwitch(name);
    }
  };

  useInput(
    (input, key) => {
      if (mode.kind === "confirm-delete" || mode.kind === "confirm-switch") {
        if (input === "y" || input === "н" || key.return) {
          if (mode.kind === "confirm-delete") {
            const r = onRemove(mode.name);
            setMessage({ ok: r.ok, text: r.message });
            setIndex((i) => Math.max(0, Math.min(i, list.length - 2)));
          } else {
            onSwitch(mode.name);
          }
          setMode({ kind: "list" });
        } else if (input === "n" || input === "т" || key.escape) {
          setMode({ kind: "list" });
        }
        return;
      }
      if (key.escape || input === "q" || input === "й") {
        onBack();
      } else if (key.upArrow) {
        setIndex((i) => Math.max(0, i - 1));
      } else if (key.downArrow) {
        setIndex((i) => Math.min(list.length - 1, i + 1));
      } else if (key.return && selected) {
        requestSwitch(selected.name);
      } else if (input === "n" || input === "т") {
        setMessage(null);
        setMode({ kind: "new", value: "", error: workspace.gitEnabled ? null : workspace.validateNewName("x") });
      } else if ((input === "d" || input === "в") && selected) {
        if (selected.name === activeName) {
          setMessage({ ok: false, text: "активную подпесочницу удалить нельзя — сначала переключитесь на другую" });
        } else {
          setMode({ kind: "confirm-delete", name: selected.name });
        }
      }
    },
    { isActive: mode.kind !== "new" }
  );

  // Esc leaves the name input (TextInput itself handles the other keys).
  useInput(
    (_input, key) => {
      if (key.escape) {
        setMode({ kind: "list" });
      }
    },
    { isActive: mode.kind === "new" }
  );

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={theme.accent} paddingX={1} flexDirection="column">
        <Text bold>
          Подпесочницы — по одной на ветку проекта
          {!workspace.gitEnabled && <Text color={theme.warn}>  (проект не git-репозиторий)</Text>}
        </Text>
        <Box flexDirection="column" marginTop={1}>
          {list.slice(first, first + maxItems).map((s, j) => {
            const i = first + j;
            const isActive = s.name === activeName;
            const missing = !fs.existsSync(workspace.registry.absPath(s));
            return (
              <Text key={s.name} color={i === index ? theme.accent : undefined} wrap="truncate-end">
                {i === index ? "❯ " : "  "}
                <Text color={isActive ? theme.ok : theme.muted}>{isActive ? "● " : "○ "}</Text>
                <Text bold={isActive}>{s.name}</Text>
                <Text color={theme.muted}>
                  {"  "}⎇ {s.branch ?? "—"}  {path.basename(workspace.registry.absPath(s))}
                </Text>
                {s.stash && <Text color={theme.warn}>  есть stash</Text>}
                {missing && <Text color={theme.error}>  папка не найдена</Text>}
              </Text>
            );
          })}
          {list.length > maxItems && (
            <Text color={theme.muted}>
              {"  "}показаны {first + 1}–{Math.min(list.length, first + maxItems)} из {list.length}
            </Text>
          )}
        </Box>
      </Box>

      {mode.kind === "new" && (
        <Box flexDirection="column" marginTop={1} paddingX={1}>
          <Box>
            <Text color={theme.accent}>Имя новой ветки и подпесочницы: </Text>
            <TextInput
              value={mode.value}
              onChange={(value) => setMode({ kind: "new", value, error: null })}
              onSubmit={(value) => {
                const error = workspace.validateNewName(value);
                if (error) {
                  setMode({ kind: "new", value, error });
                } else {
                  onCreate(value.trim());
                }
              }}
            />
          </Box>
          {mode.value.trim() && (
            <Text color={theme.muted} wrap="truncate-middle">
              ветка {mode.value.trim()} от {workspace.git?.currentBranch() ?? "HEAD"} · папка{" "}
              {workspace.folderFor(mode.value.trim())}
            </Text>
          )}
          {mode.error && <Text color={theme.error}>{mode.error}</Text>}
          <Text color={theme.muted}>Enter — создать и переключиться · Esc — отмена</Text>
        </Box>
      )}

      {mode.kind === "confirm-delete" && (
        <Box flexDirection="column" marginTop={1} paddingX={1}>
          <Text color={theme.warn}>
            Удалить подпесочницу «{mode.name}»? Папка уйдёт в .anonymus/trash, git-ветка останется.
          </Text>
          <Text>
            <Text color={theme.accent}>y</Text> удалить · <Text color={theme.accent}>n</Text> отмена
          </Text>
        </Box>
      )}

      {mode.kind === "confirm-switch" && (
        <Box flexDirection="column" marginTop={1} paddingX={1}>
          <Text color={theme.warn}>
            {heldCount} {plural(heldCount, "файл ждёт", "файла ждут", "файлов ждут")} решения в текущей
            подпесочнице. Они останутся как есть и снова появятся при возврате. Переключиться на «{mode.name}»?
          </Text>
          <Text>
            <Text color={theme.accent}>y</Text> переключиться · <Text color={theme.accent}>n</Text> отмена
          </Text>
        </Box>
      )}

      {mode.kind === "list" && (
        <Box flexDirection="column" marginTop={1} paddingX={1}>
          {message && <Text color={message.ok ? theme.ok : theme.error}>{message.text}</Text>}
          <Text color={theme.muted} wrap="truncate-end">
            Enter переключиться · n новая · d удалить · ↑↓ выбрать · Esc назад
          </Text>
        </Box>
      )}
    </Box>
  );
}
