import * as fs from "node:fs";
import * as path from "node:path";
import { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { defaultMergeSources } from "../core/mergePrep.js";
import type { Workspace } from "../core/workspace.js";
import { plural, theme } from "./theme.js";

export interface ActionResult {
  ok: boolean;
  lines: string[];
}

type Mode =
  | { kind: "list" }
  | { kind: "new"; value: string; base: number; error: string | null }
  | { kind: "new-confirm"; name: string; from: string }
  | { kind: "confirm-delete"; name: string }
  | { kind: "confirm-switch"; name: string }
  | { kind: "merge"; target: string; sources: string[]; picked: Set<string>; index: number }
  | { kind: "commit"; value: string };

/**
 * Sub-sandboxes of the project: one per git branch. Switch (Enter), create a
 * new one off any branch (n), remove (d), prepare the work of other
 * sub-sandboxes for merging into the selected one (m), commit the active one (k).
 */
export function SandboxesView({
  workspace,
  heldCount,
  maxItems,
  onSwitch,
  onCreate,
  onRemove,
  onPrepareMerge,
  onCommit,
  onBack,
}: {
  workspace: Workspace;
  heldCount: number;
  maxItems: number;
  onSwitch: (name: string) => void;
  onCreate: (name: string, from: string, switchTo: boolean) => ActionResult | void;
  onRemove: (name: string) => ActionResult;
  onPrepareMerge: (target: string, sources: string[]) => ActionResult;
  onCommit: (message: string) => ActionResult;
  onBack: () => void;
}) {
  const list = workspace.registry.list();
  const activeName = workspace.active.name;
  const bases = workspace.baseBranchChoices();
  const [index, setIndex] = useState(() => Math.max(0, list.findIndex((s) => s.name === activeName)));
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [result, setResult] = useState<ActionResult | null>(null);
  const selected = list[Math.min(index, list.length - 1)];
  const first = Math.max(0, Math.min(index - Math.floor(maxItems / 2), list.length - maxItems));
  const show = (r: ActionResult) => setResult(r);

  const requestSwitch = (name: string) => {
    if (name === activeName) {
      show({ ok: true, lines: [`«${name}» уже активна`] });
    } else if (heldCount > 0) {
      setMode({ kind: "confirm-switch", name });
    } else {
      onSwitch(name);
    }
  };

  const startMerge = () => {
    if (!selected?.branch) {
      show({ ok: false, lines: ["у этой подпесочницы нет ветки"] });
      return;
    }
    const sources = list.filter((s) => s.name !== selected.name && s.branch).map((s) => s.name);
    if (sources.length === 0) {
      show({ ok: false, lines: ["нет других подпесочниц, работу которых можно слить"] });
      return;
    }
    setResult(null);
    setMode({
      kind: "merge",
      target: selected.name,
      sources,
      picked: new Set(defaultMergeSources(workspace, selected.name)),
      index: 0,
    });
  };

  // List and simple confirmations.
  useInput(
    (input, key) => {
      if (mode.kind === "confirm-delete" || mode.kind === "confirm-switch") {
        if (input === "y" || input === "н" || key.return) {
          if (mode.kind === "confirm-delete") {
            show(onRemove(mode.name));
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
      if (mode.kind === "new-confirm") {
        if (key.return) {
          onCreate(mode.name, mode.from, true);
        } else if (input === "s" || input === "ы") {
          const r = onCreate(mode.name, mode.from, false);
          if (r) show(r);
          setMode({ kind: "list" });
        } else if (key.escape) {
          setMode({ kind: "list" });
        }
        return;
      }
      if (mode.kind === "merge") {
        if (key.escape) {
          setMode({ kind: "list" });
        } else if (key.upArrow) {
          setMode({ ...mode, index: Math.max(0, mode.index - 1) });
        } else if (key.downArrow) {
          setMode({ ...mode, index: Math.min(mode.sources.length - 1, mode.index + 1) });
        } else if (input === " ") {
          const picked = new Set(mode.picked);
          const name = mode.sources[mode.index];
          picked.has(name) ? picked.delete(name) : picked.add(name);
          setMode({ ...mode, picked });
        } else if (key.return) {
          show(onPrepareMerge(mode.target, mode.sources.filter((s) => mode.picked.has(s))));
          setMode({ kind: "list" });
        }
        return;
      }
      if (mode.kind !== "list") {
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
        setResult(null);
        setMode({ kind: "new", value: "", base: 0, error: workspace.gitEnabled ? null : workspace.validateNewName("x") });
      } else if ((input === "d" || input === "в") && selected) {
        if (selected.name === activeName) {
          show({ ok: false, lines: ["активную подпесочницу удалить нельзя — сначала переключитесь на другую"] });
        } else {
          setMode({ kind: "confirm-delete", name: selected.name });
        }
      } else if (input === "m" || input === "ь") {
        startMerge();
      } else if (input === "k" || input === "л") {
        setResult(null);
        setMode({ kind: "commit", value: workspace.defaultCommitMessage() });
      }
    },
    { isActive: mode.kind !== "new" && mode.kind !== "commit" }
  );

  // Text inputs: Esc leaves, Tab cycles the base branch of a new sub-sandbox.
  useInput(
    (_input, key) => {
      if (key.escape) {
        setMode({ kind: "list" });
      } else if (key.tab && mode.kind === "new" && bases.length > 1) {
        setMode({ ...mode, base: (mode.base + 1) % bases.length });
      }
    },
    { isActive: mode.kind === "new" || mode.kind === "commit" }
  );

  const from = mode.kind === "new" ? bases[mode.base] ?? "HEAD" : "";

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
                  {"  "}⎇ {s.branch ?? "—"}
                  {s.base ? ` от ${s.base.branch}` : ""}  {path.basename(workspace.registry.absPath(s))}
                </Text>
                {s.stash && <Text color={theme.warn}>  есть stash</Text>}
                {s.mergeSources?.length ? <Text color={theme.info}>  слияние готово</Text> : null}
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
              onChange={(value) => setMode({ ...mode, value, error: null })}
              onSubmit={(value) => {
                const error = workspace.validateNewName(value);
                if (error) {
                  setMode({ ...mode, value, error });
                } else {
                  setMode({ kind: "new-confirm", name: value.trim(), from });
                }
              }}
            />
          </Box>
          <Text>
            <Text color={theme.muted}>от ветки: </Text>
            <Text bold>{from}</Text>
            {bases.length > 1 && <Text color={theme.muted}>   (Tab — другая)</Text>}
          </Text>
          {mode.value.trim() && (
            <Text color={theme.muted} wrap="truncate-middle">
              папка {workspace.folderFor(mode.value.trim())}
            </Text>
          )}
          {mode.error && <Text color={theme.error}>{mode.error}</Text>}
          <Text color={theme.muted}>Enter — дальше · Esc — отмена</Text>
        </Box>
      )}

      {mode.kind === "new-confirm" && (
        <Box flexDirection="column" marginTop={1} paddingX={1}>
          <Text>
            Новая подпесочница <Text bold>{mode.name}</Text> от ветки <Text bold>{mode.from}</Text>
          </Text>
          <Text>
            <Text color={theme.accent}>Enter</Text> создать и переключиться · <Text color={theme.accent}>s</Text>{" "}
            создать, не переключаясь (папка заполнится из ветки) · <Text color={theme.accent}>Esc</Text> отмена
          </Text>
        </Box>
      )}

      {mode.kind === "merge" && (
        <Box flexDirection="column" marginTop={1} paddingX={1}>
          <Text>
            Слить в <Text bold>{mode.target}</Text> работу подпесочниц:
          </Text>
          {mode.sources.map((name, i) => {
            const s = workspace.registry.get(name)!;
            return (
              <Text key={name} color={i === mode.index ? theme.accent : undefined} wrap="truncate-end">
                {i === mode.index ? "❯ " : "  "}[{mode.picked.has(name) ? "x" : " "}] {name}
                <Text color={theme.muted}>  ⎇ {s.branch}{s.base ? ` от ${s.base.branch}` : ""}</Text>
              </Text>
            );
          })}
          <Text color={theme.muted} wrap="truncate-end">
            пробел — отметить · Enter — подготовить патчи в .anonymus-merge/ · Esc — отмена
          </Text>
        </Box>
      )}

      {mode.kind === "commit" && (
        <Box flexDirection="column" marginTop={1} paddingX={1}>
          <Box>
            <Text color={theme.accent}>Коммит в {workspace.active.branch}: </Text>
            <TextInput
              value={mode.value}
              onChange={(value) => setMode({ kind: "commit", value })}
              onSubmit={(value) => {
                show(onCommit(value.trim() || workspace.defaultCommitMessage()));
                setMode({ kind: "list" });
              }}
            />
          </Box>
          <Text color={theme.muted}>Enter — закоммитить незакоммиченную работу активной подпесочницы · Esc — отмена</Text>
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
          {result?.lines.map((line, i) => (
            <Text key={i} color={result.ok ? (i === 0 ? theme.ok : undefined) : theme.error} wrap="truncate-end">
              {line}
            </Text>
          ))}
          <Text color={theme.muted} wrap="truncate-end">
            Enter переключиться · n новая · m слить сюда · k коммит · d удалить · Esc назад
          </Text>
        </Box>
      )}
    </Box>
  );
}
