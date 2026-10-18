import { Box, Text, useInput } from "ink";
import type { SyncEvent } from "../core/syncer.js";
import type { BranchProblem, Workspace } from "../core/workspace.js";
import { EventLine } from "./LiveView.js";
import { theme } from "./theme.js";

/** Rows BranchView needs besides the recent log lines. */
export const BRANCH_VIEW_ROWS = 11;

/**
 * Shown instead of the scan when the project is on another branch than the
 * active sub-sandbox: syncing now would copy that branch into this sandbox.
 * Nothing is scanned or synced until the user picks.
 */
export function BranchView({
  workspace,
  problem,
  events,
  logRows,
  onAdopt,
  onCreate,
  onCheckout,
  onSandboxes,
  onQuit,
}: {
  workspace: Workspace;
  problem: BranchProblem;
  events: SyncEvent[];
  logRows: number;
  /** Switch to the sub-sandbox of the branch checked out now. */
  onAdopt: (name: string) => void;
  /** New sub-sandbox for the branch checked out now. */
  onCreate: () => void;
  /** git checkout the active sub-sandbox's branch. */
  onCheckout: () => void;
  onSandboxes: () => void;
  onQuit: () => void;
}) {
  const actual = problem.actual;
  const actualName = actual ?? "отделённый HEAD";
  const createProblem = actual && !problem.target ? workspace.validateAdopt(actual) : null;
  const canCreate = actual !== null && !problem.target && createProblem === null;

  useInput((input) => {
    if ((input === "s" || input === "ы") && problem.target) {
      onAdopt(problem.target);
    } else if ((input === "a" || input === "ф") && canCreate) {
      onCreate();
    } else if (input === "x" || input === "ч") {
      onCheckout();
    } else if (input === "b" || input === "и") {
      onSandboxes();
    } else if (input === "q" || input === "й") {
      onQuit();
    }
  });

  const shown = events.slice(-Math.max(0, logRows));
  const key = (k: string) => <Text color={theme.accent}>{k}</Text>;
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box borderStyle="round" borderColor={theme.error} paddingX={1} flexShrink={0}>
        <Text color={theme.error} wrap="truncate-end">
          ⚠ в проекте ветка {actualName}, а подпесочница «{workspace.active.name}» привязана к {problem.expected}
        </Text>
      </Box>
      <Box paddingX={1} flexShrink={0}>
        <Text color={theme.muted} wrap="wrap">
          Синхронизация не запущена: файлы ветки {actualName} попали бы в подпесочницу ветки {problem.expected}.
        </Text>
      </Box>

      <Box flexDirection="column" paddingX={1} marginTop={1} flexShrink={0}>
        {problem.target ? (
          <Text wrap="truncate-end">
            {key("s")}  перейти на подпесочницу «{problem.target}» ветки {actualName}
          </Text>
        ) : canCreate ? (
          <Text wrap="truncate-end">
            {key("a")}  новая подпесочница для ветки {actualName}
            <Text color={theme.muted}>  → {workspace.folderFor(actual!)}</Text>
          </Text>
        ) : (
          <Text color={theme.muted} wrap="truncate-end">
            {actual ? `подпесочницу для ${actual} создать нельзя: ${createProblem}` : "к отделённому HEAD подпесочницу не привязать"}
          </Text>
        )}
        <Text wrap="truncate-end">
          {key("x")}  git checkout {problem.expected} — вернуть ветку подпесочницы «{workspace.active.name}»
        </Text>
        <Text wrap="truncate-end">{key("b")}  список подпесочниц</Text>
        <Text wrap="truncate-end">{key("q")}  выход</Text>
      </Box>

      <Box flexDirection="column" paddingX={1} marginTop={1} flexGrow={1} overflow="hidden">
        {shown.map((e, i) => (
          <EventLine key={i} event={e} />
        ))}
      </Box>
    </Box>
  );
}
