import { useState } from "react";
import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import { defaultMergeSources } from "../core/mergePrep.js";
import type { PairProblem, ProblemCode } from "../core/pairGuard.js";
import type { SyncEvent } from "../core/syncer.js";
import type { Workspace } from "../core/workspace.js";
import { EventLine } from "./EventLine.js";
import type { ActionResult, PairView } from "./pairState.js";
import { plural, theme } from "./theme.js";

type Mode =
  | { kind: "list" }
  | { kind: "new"; value: string; base: number; error: string | null }
  | { kind: "confirm-delete"; name: string; uncommitted: number }
  | { kind: "confirm-abort"; name: string }
  | { kind: "merge"; target: string; sources: string[]; picked: Set<string>; index: number }
  | { kind: "commit"; name: string; value: string }
  | { kind: "busy"; text: string };

/**
 * Main screen: every pair (sub-sandbox ⇄ its worktree) with its state, the
 * shared journal below. All pairs sync at the same time; the keys act on the
 * selected one.
 */
export function PairsView({
  workspace,
  pairs,
  events,
  maxItems,
  rows,
  logPath,
  onOpen,
  onConflicts,
  onCreate,
  onRemove,
  onMerge,
  onContinueMerge,
  onAbortMerge,
  onCommit,
  onPause,
  onRescan,
  onTrash,
  onQuit,
}: {
  workspace: Workspace;
  pairs: PairView[];
  events: SyncEvent[];
  maxItems: number;
  /** Rows available to the whole view (the log gets what is left). */
  rows: number;
  logPath: string;
  /** Enter: whatever the pair needs (reconcile, conflicts, its problem). */
  onOpen: (name: string) => void;
  onConflicts: (name: string) => void;
  onCreate: (name: string, from: string) => Promise<ActionResult>;
  onRemove: (name: string, force: boolean) => Promise<ActionResult>;
  onMerge: (target: string, sources: string[]) => ActionResult;
  onContinueMerge: (target: string) => ActionResult;
  onAbortMerge: (target: string) => ActionResult;
  onCommit: (name: string, message: string) => ActionResult;
  onPause: (name: string) => void;
  onRescan: (name: string) => void;
  onTrash: () => void;
  onQuit: () => void;
}) {
  const bases = workspace.baseBranchChoices();
  const [index, setIndex] = useState(0);
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [result, setResult] = useState<ActionResult | null>(null);
  const selected = pairs[Math.min(index, pairs.length - 1)];
  const first = Math.max(0, Math.min(index - Math.floor(maxItems / 2), pairs.length - maxItems));
  const git = workspace.gitEnabled;

  const show = (r: ActionResult) => setResult(r);
  const runAsync = (text: string, action: () => Promise<ActionResult>) => {
    setResult(null);
    setMode({ kind: "busy", text });
    void action().then((r) => {
      show(r);
      setMode({ kind: "list" });
    });
  };
  const needGit = (): boolean => {
    if (!git) {
      show({ ok: false, lines: ["проект не git-репозиторий — подпесочницы по веткам недоступны"] });
    }
    return git;
  };

  const startMerge = () => {
    if (!selected || !needGit()) return;
    if (selected.merge?.current) {
      show({ ok: false, lines: [`слияние ${selected.merge.current} уже идёт: k — продолжить, a — прервать`] });
      return;
    }
    const sources = pairs.filter((p) => p.name !== selected.name).map((p) => p.name);
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

  useInput(
    (input, key) => {
      if (mode.kind === "busy") {
        return;
      }
      if (mode.kind === "confirm-delete") {
        if (input === "y" || input === "н") {
          const { name, uncommitted } = mode;
          setIndex((i) => Math.max(0, Math.min(i, pairs.length - 2)));
          runAsync(`удаляю «${name}»`, () => onRemove(name, uncommitted > 0));
        } else if (input === "n" || input === "т" || key.escape) {
          setMode({ kind: "list" });
        }
        return;
      }
      if (mode.kind === "confirm-abort") {
        if (input === "y" || input === "н") {
          show(onAbortMerge(mode.name));
          setMode({ kind: "list" });
        } else if (input === "n" || input === "т" || key.escape) {
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
          show(onMerge(mode.target, mode.sources.filter((s) => mode.picked.has(s))));
          setMode({ kind: "list" });
        }
        return;
      }
      if (mode.kind !== "list") {
        return;
      }
      if (input === "q" || input === "й") {
        onQuit();
      } else if (key.upArrow) {
        setIndex((i) => Math.max(0, i - 1));
      } else if (key.downArrow) {
        setIndex((i) => Math.min(pairs.length - 1, i + 1));
      } else if (key.return && selected) {
        onOpen(selected.name);
      } else if ((input === "c" || input === "с") && selected) {
        onConflicts(selected.name);
      } else if ((input === "p" || input === "з") && selected) {
        onPause(selected.name);
      } else if ((input === "r" || input === "к") && selected) {
        onRescan(selected.name);
      } else if (input === "o" || input === "щ") {
        onTrash();
      } else if ((input === "n" || input === "т") && needGit()) {
        setResult(null);
        setMode({ kind: "new", value: "", base: 0, error: null });
      } else if ((input === "d" || input === "в") && selected && needGit()) {
        setResult(null);
        setMode({ kind: "confirm-delete", name: selected.name, uncommitted: workspace.uncommitted(selected.name).length });
      } else if ((input === "m" || input === "ь") && selected) {
        startMerge();
      } else if ((input === "k" || input === "л") && selected && needGit()) {
        if (selected.merge?.current) {
          show(onContinueMerge(selected.name));
        } else {
          setResult(null);
          setMode({ kind: "commit", name: selected.name, value: workspace.defaultCommitMessage(selected.name) });
        }
      } else if ((input === "a" || input === "ф") && selected?.merge) {
        setResult(null);
        setMode({ kind: "confirm-abort", name: selected.name });
      }
    },
    { isActive: mode.kind !== "new" && mode.kind !== "commit" }
  );

  // Text inputs: Esc leaves, Tab cycles the base branch of a new pair.
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
  const newName = mode.kind === "new" ? mode.value.trim() : "";
  // The log gets whatever the list, the action area and the key hints leave.
  const listRows = Math.max(1, Math.min(pairs.length, maxItems)) + (pairs.length > maxItems ? 1 : 0);
  const modeRows =
    mode.kind === "new"
      ? 5
      : mode.kind === "merge"
        ? mode.sources.length + 2
        : mode.kind === "commit"
          ? 2
          : mode.kind === "confirm-delete"
            ? mode.uncommitted > 0 ? 6 : 3
            : mode.kind === "confirm-abort"
              ? 3
              : mode.kind === "busy"
                ? 1
                : (result?.lines.length ?? 0);
  const logRows = Math.max(1, rows - (3 + listRows) - modeRows - 2);
  const shownLog = events.slice(-logRows);

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box borderStyle="round" borderColor={theme.accent} paddingX={1} flexDirection="column" flexShrink={0}>
        <Text bold wrap="truncate-end">
          {git ? "Подпесочницы — у каждой свой worktree, синхронизируются одновременно" : "Проект ⇄ песочница"}
        </Text>
        {pairs.length === 0 && (
          <Text color={theme.muted}>Подпесочниц пока нет — n создать первую (ветка + worktree + песочница).</Text>
        )}
        {pairs.slice(first, first + maxItems).map((p, j) => {
          const i = first + j;
          return (
            <Box key={p.name}>
              <Box flexGrow={1} flexShrink={1}>
                <Text color={i === index ? theme.accent : undefined} wrap="truncate-end">
                  {i === index ? "❯ " : "  "}
                  <PhaseIcon pair={p} /> <Text bold>{p.name}</Text>
                  {p.branch && (
                    <Text color={theme.muted}>
                      {"  "}⎇ {p.branch}
                      {p.base ? ` от ${p.base}` : ""}
                    </Text>
                  )}
                  {"  "}
                  <PhaseText pair={p} />
                </Text>
              </Box>
              <Box flexShrink={0} marginLeft={1}>
                <Text color={theme.muted}>
                  <Text color={theme.sandbox}>→{p.stats.toSandbox}</Text> <Text color={theme.project}>←{p.stats.toProject}</Text>{" "}
                  ✕{p.stats.deleted}
                </Text>
              </Box>
            </Box>
          );
        })}
        {pairs.length > maxItems && (
          <Text color={theme.muted}>
            {"  "}показаны {first + 1}–{Math.min(pairs.length, first + maxItems)} из {pairs.length}
          </Text>
        )}
      </Box>

      {mode.kind === "new" && (
        <Box flexDirection="column" paddingX={1} flexShrink={0}>
          <Box>
            <Text color={theme.accent}>Имя новой подпесочницы (= ветки): </Text>
            <TextInput
              value={mode.value}
              onChange={(value) => setMode({ ...mode, value, error: null })}
              onSubmit={(value) => {
                const error = workspace.validateNewName(value);
                if (error) {
                  setMode({ ...mode, value, error });
                } else {
                  const name = value.trim();
                  runAsync(`создаю «${name}»`, () => onCreate(name, from));
                }
              }}
            />
          </Box>
          {newName && workspace.isExistingBranch(newName) ? (
            <Text color={theme.muted}>ветка {newName} уже есть — подпесочница возьмёт её</Text>
          ) : (
            <Text>
              <Text color={theme.muted}>от ветки: </Text>
              <Text bold>{from}</Text>
              {bases.length > 1 && <Text color={theme.muted}>   (Tab — другая)</Text>}
            </Text>
          )}
          {newName && (
            <Text color={theme.muted} wrap="truncate-middle">
              worktree {workspace.worktreeFor(newName)} · песочница {workspace.folderFor(newName)}
            </Text>
          )}
          {mode.error && <Text color={theme.error}>{mode.error}</Text>}
          <Text color={theme.muted}>Enter — создать · Esc — отмена</Text>
        </Box>
      )}

      {mode.kind === "merge" && (
        <Box flexDirection="column" paddingX={1} flexShrink={0}>
          <Text>
            Слить в <Text bold>{mode.target}</Text> (git merge в её worktree) работу:
          </Text>
          {mode.sources.map((name, i) => {
            const p = pairs.find((x) => x.name === name);
            return (
              <Text key={name} color={i === mode.index ? theme.accent : undefined} wrap="truncate-end">
                {i === mode.index ? "❯ " : "  "}[{mode.picked.has(name) ? "x" : " "}] {name}
                <Text color={theme.muted}>
                  {"  "}⎇ {p?.branch}
                  {p?.base ? ` от ${p.base}` : ""}
                </Text>
              </Text>
            );
          })}
          <Text color={theme.muted} wrap="truncate-end">
            пробел — отметить · Enter — закоммитить их работу и слить по очереди · Esc — отмена
          </Text>
        </Box>
      )}

      {mode.kind === "commit" && (
        <Box flexDirection="column" paddingX={1} flexShrink={0}>
          <Box>
            <Text color={theme.accent}>Коммит в {pairs.find((p) => p.name === mode.name)?.branch}: </Text>
            <TextInput
              value={mode.value}
              onChange={(value) => setMode({ ...mode, value })}
              onSubmit={(value) => {
                show(onCommit(mode.name, value.trim() || workspace.defaultCommitMessage(mode.name)));
                setMode({ kind: "list" });
              }}
            />
          </Box>
          <Text color={theme.muted}>Enter — закоммитить незакоммиченное в worktree подпесочницы · Esc — отмена</Text>
        </Box>
      )}

      {mode.kind === "confirm-delete" && (
        <Box flexDirection="column" paddingX={1} flexShrink={0}>
          <Text color={theme.warn} wrap="wrap">
            Удалить подпесочницу «{mode.name}»? Песочница уйдёт в .anonymus/trash, worktree удалится, git-ветка
            останется.
          </Text>
          {mode.uncommitted > 0 && (
            <Text color={theme.error} wrap="wrap">
              В её worktree {mode.uncommitted} {plural(mode.uncommitted, "незакоммиченный файл", "незакоммиченных файла", "незакоммиченных файлов")}:
              их копии лягут в корзину, а в git их не будет. Лучше сначала закоммитить (k).
            </Text>
          )}
          <Text>
            <Text color={theme.accent}>y</Text> удалить · <Text color={theme.accent}>n</Text> отмена
          </Text>
        </Box>
      )}

      {mode.kind === "confirm-abort" && (
        <Box flexDirection="column" paddingX={1} flexShrink={0}>
          <Text color={theme.warn}>
            Прервать слияние в «{mode.name}»? git merge --abort вернёт её worktree к состоянию до слияния, синхронизация
            вернёт и песочницу.
          </Text>
          <Text>
            <Text color={theme.accent}>y</Text> прервать · <Text color={theme.accent}>n</Text> отмена
          </Text>
        </Box>
      )}

      {mode.kind === "busy" && (
        <Box paddingX={1} flexShrink={0}>
          <Text color={theme.accent}>
            <Spinner type="dots" /> {mode.text}
          </Text>
        </Box>
      )}

      {mode.kind === "list" && result && (
        <Box flexDirection="column" paddingX={1} flexShrink={0}>
          {result.lines.map((line, i) => (
            <Text key={i} color={result.ok ? (i === 0 ? theme.ok : undefined) : theme.error} wrap="truncate-end">
              {line}
            </Text>
          ))}
        </Box>
      )}

      <Box paddingX={1} flexShrink={0}>
        <Text color={theme.muted} wrap="truncate-middle">журнал: {logPath}</Text>
      </Box>
      <Box flexDirection="column" paddingX={1} flexGrow={1} overflow="hidden">
        {shownLog.length === 0 ? (
          <Text color={theme.muted}>Пока тихо. Изменения появятся здесь.</Text>
        ) : (
          shownLog.map((e, i) => <EventLine key={i} event={e} showPair={git} />)
        )}
      </Box>

      <Box paddingX={1} flexShrink={0}>
        <Text color={theme.muted} wrap="truncate-end">
          ↑↓ выбрать · Enter открыть · c конфликты · p {selected?.paused ? "продолжить" : "пауза"} · r скан
          {git ? " · n новая · d удалить · m слить сюда · k коммит" : ""}
          {selected?.merge ? " · a прервать слияние" : ""} · o корзина · q выход
        </Text>
      </Box>
    </Box>
  );
}

/** A stopped pair's reason in a few words (the full text is on its problem screen). */
const SHORT_PROBLEM: Record<ProblemCode, (p: PairProblem) => string> = {
  "worktree-missing": () => "worktree удалён",
  "not-worktree": () => "на месте worktree не worktree",
  "foreign-worktree": () => "чужой worktree",
  "wrong-branch": (p) => `в worktree ${p.actualBranch ? `ветка ${p.actualBranch}` : "отделённая HEAD"}`,
  "sandbox-missing": () => "песочница пропала",
  "mass-delete": (p) => `массовое удаление (${p.count ?? "?"})`,
  "io-error": () => "ошибка чтения",
};

function PhaseIcon({ pair: p }: { pair: PairView }) {
  if (p.phase === "blocked") return <Text color={theme.error}>✖</Text>;
  if (p.phase === "review") return <Text color={theme.warn}>?</Text>;
  if (p.phase === "waiting") return <Text color={theme.muted}>·</Text>;
  if (p.phase === "scanning" || p.phase === "applying") return <Spinner type="dots" />;
  if (p.held > 0 || p.merge?.current) return <Text color={theme.error}>!</Text>;
  if (p.paused) return <Text color={theme.warn}>⏸</Text>;
  return <Text color={theme.ok}>●</Text>;
}

function PhaseText({ pair: p }: { pair: PairView }) {
  const merge = p.merge?.current ? (
    <Text color={theme.info}>
      {"  "}⇄ слияние {p.merge.current}: конфликты — агент разрешает, затем k
    </Text>
  ) : null;
  switch (p.phase) {
    case "waiting":
      return <Text color={theme.muted}>в очереди</Text>;
    case "scanning":
      return (
        <Text color={theme.muted}>
          сравниваю{p.progress[1] > 0 ? ` ${p.progress[0]}/${p.progress[1]}` : ""}
        </Text>
      );
    case "applying":
      return <Text color={theme.muted}>применяю сверку</Text>;
    case "review":
      return (
        <Text color={theme.warn}>
          {p.needsReview ? "worktree восстановлен — проверьте сверку, Enter" : "проект и песочница расходятся — Enter"}
        </Text>
      );
    case "blocked":
      return <Text color={theme.error}>остановлена: {p.problem ? SHORT_PROBLEM[p.problem.code](p.problem) : "?"} — Enter</Text>;
    case "live":
      if (p.held > 0) {
        return (
          <Text>
            <Text color={theme.error}>
              {p.held} {plural(p.held, "файл ждёт", "файла ждут", "файлов ждут")} решения — c
            </Text>
            {merge}
          </Text>
        );
      }
      if (p.paused) {
        return (
          <Text>
            <Text color={theme.warn}>пауза</Text>
            {merge}
          </Text>
        );
      }
      return (
        <Text>
          {p.busy || p.pending > 0 ? (
            <Text color={theme.accent}>синхронизирую{p.pending > 0 ? ` · в очереди ${p.pending}` : ""}</Text>
          ) : (
            <Text color={theme.ok}>синхронно</Text>
          )}
          {merge}
        </Text>
      );
  }
}
