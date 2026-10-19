import { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { PairProblem } from "../core/pairGuard.js";
import type { PairRef } from "../core/workspace.js";
import { theme } from "./theme.js";

/** What the user can do about a stopped pair. */
export type ProblemAction = "recreate" | "relink" | "relocate" | "checkout" | "refill" | "reconcile" | "recheck" | "remove";

interface Choice {
  key: string;
  action: ProblemAction;
  label: string;
  /** Asked again with y before it runs. */
  confirm?: string;
}

/**
 * A pair stopped because syncing it would be unsafe (see core/pairGuard.ts):
 * what happened, what is safe now, and the ways out. Nothing syncs until the
 * user picks one; other pairs keep syncing meanwhile.
 */
export function ProblemView({
  pair,
  problem,
  movedTo,
  onAction,
  onBack,
}: {
  pair: PairRef;
  problem: PairProblem;
  /** The worktree was found elsewhere (git worktree move). */
  movedTo: string | null;
  onAction: (action: ProblemAction) => void;
  onBack: () => void;
}) {
  const [asking, setAsking] = useState<Choice | null>(null);
  const choices = choicesFor(pair, problem, movedTo);

  useInput((input, key) => {
    if (asking) {
      if (input === "y" || input === "н") {
        onAction(asking.action);
      } else if (input === "n" || input === "т" || key.escape) {
        setAsking(null);
      }
      return;
    }
    if (key.escape || input === "q" || input === "й") {
      onBack();
      return;
    }
    const choice = key.return ? choices.find((c) => c.key === "Enter") : choices.find((c) => c.key === input);
    if (choice) {
      choice.confirm ? setAsking(choice) : onAction(choice.action);
    }
  });

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={theme.error} paddingX={1} flexDirection="column">
        <Text bold color={theme.error} wrap="wrap">
          ✖ «{pair.name}» остановлена: {problem.message}
        </Text>
        <Box marginTop={1} flexDirection="column">
          <Text wrap="wrap">{explain(problem)}</Text>
          <Text color={theme.muted} wrap="truncate-middle">
            worktree  {pair.projectDir}
          </Text>
          <Text color={theme.muted} wrap="truncate-middle">
            песочница {pair.sandboxDir}
          </Text>
        </Box>
      </Box>

      <Box flexDirection="column" marginTop={1} paddingX={1}>
        {asking ? (
          <>
            <Text color={theme.warn} wrap="wrap">
              {asking.confirm}
            </Text>
            <Text>
              <Text color={theme.accent}>y</Text> да · <Text color={theme.accent}>n</Text> отмена
            </Text>
          </>
        ) : (
          <>
            {choices.map((c) => (
              <Text key={c.key} wrap="wrap">
                <Text color={theme.accent}>{c.key.padEnd(5)}</Text> {c.label}
              </Text>
            ))}
            <Text color={theme.muted}>Esc — назад (подпесочница остаётся остановленной, остальные работают)</Text>
          </>
        )}
      </Box>
    </Box>
  );
}

function explain(problem: PairProblem): string {
  switch (problem.code) {
    case "worktree-missing":
    case "not-worktree":
      return (
        "Синхронизация остановлена до того, как изменения разошлись: песочница не тронута. " +
        "Незакоммиченная работа этого worktree осталась только в песочнице."
      );
    case "foreign-worktree":
      return (
        "По этому пути теперь другой worktree — не тот, что создавал anonymus (например, его удалили и создали " +
        "заново через git). Синхронизировать с ним песочницу без проверки опасно."
      );
    case "wrong-branch":
      return "Синхронизация остановлена, чтобы в песочницу не попала другая ветка. Песочница не тронута.";
    case "sandbox-missing":
      return "Синхронизация остановлена, чтобы исчезновение песочницы не удалило файлы в worktree.";
    case "mass-delete":
      return (
        `Исчезло слишком много файлов сразу (${problem.count ?? "?"}) — так выглядит случайное удаление, а не правка. ` +
        "На другой стороне они пока целы. На экране сверки можно вернуть их или подтвердить удаление."
      );
    case "io-error":
      return "Папки подпесочницы не удалось прочитать. Исправьте причину и проверьте снова.";
  }
}

function choicesFor(pair: PairRef, problem: PairProblem, movedTo: string | null): Choice[] {
  const remove: Choice = {
    key: "d",
    action: "remove",
    label: "удалить подпесочницу (песочница — в корзину, чужую папку anonymus не тронет)",
    confirm: `Удалить подпесочницу «${pair.name}»? Песочница уйдёт в .anonymus/trash, git-ветка останется.`,
  };
  const recheck: Choice = { key: "r", action: "recheck", label: "проверить снова (если уже исправили вручную)" };
  const recreate: Choice = {
    key: "w",
    action: "recreate",
    label: `пересоздать worktree из ветки ${pair.branch}, затем сверка (рекомендуется «Песочница → проект»)`,
    confirm:
      `Создать worktree заново в ${pair.projectDir}? Если там что-то лежит, оно уйдёт в корзину. ` +
      "История синхронизации сбросится, сверку вы проверите сами.",
  };
  const relocate: Choice[] = movedTo
    ? [{ key: "u", action: "relocate", label: `worktree перемещён в ${movedTo} — продолжить с ним` }]
    : [];
  switch (problem.code) {
    case "worktree-missing":
    case "not-worktree":
      return [...relocate, recreate, recheck, remove];
    case "foreign-worktree":
      return [
        ...relocate,
        {
          key: "l",
          action: "relink",
          label: "это правильный worktree — привязать его (затем сверка без автоматики)",
          confirm:
            `Привязать ${pair.projectDir} к «${pair.name}»? История синхронизации сбросится, ` +
            "сверку проекта и песочницы вы проверите сами.",
        },
        recreate,
        recheck,
        remove,
      ];
    case "wrong-branch":
      return [
        { key: "x", action: "checkout", label: `вернуть в worktree ветку ${pair.branch} (git checkout)` },
        recheck,
        remove,
      ];
    case "sandbox-missing":
      return [
        { key: "f", action: "refill", label: "создать песочницу заново и заполнить её из worktree" },
        recheck,
        remove,
      ];
    case "mass-delete":
      return [{ key: "Enter", action: "reconcile", label: "открыть сверку: вернуть файлы или подтвердить удаление" }, remove];
    case "io-error":
      return [recheck, remove];
  }
}
