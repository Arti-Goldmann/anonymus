import * as path from "node:path";
import { Box, Text } from "ink";
import type { AnonymusConfig } from "../config/schema.js";
import { MASCOT_SPRITE, renderMascot } from "./mascot.js";
import { plural, theme } from "./theme.js";

const MASCOT_LINES = renderMascot();

/** Rows taken by the full header (mascot + blank line below). */
export const HEADER_ROWS = MASCOT_SPRITE.length / 2 + 1;
/** Narrowest window the full header fits into. */
export const HEADER_MIN_COLUMNS = 90;

export interface PairsSummary {
  total: number;
  /** Pairs that need the user (reconcile, conflicts, a problem). */
  attention: number;
  git: boolean;
}

/** Full header: mascot on the left, name and the folders on the right. */
export function Header({ config, version, summary }: { config: AnonymusConfig; version: string; summary: PairsSummary }) {
  return (
    <Box flexDirection="row" gap={3} marginBottom={1} flexShrink={0}>
      <Box flexDirection="column" flexShrink={0}>
        {MASCOT_LINES.map((line, i) => (
          <Text key={i}>{line}</Text>
        ))}
      </Box>
      <Box flexDirection="column" justifyContent="center" flexShrink={1}>
        <Text wrap="truncate-end">
          <Text bold color={theme.accent}>
            anonymus
          </Text>
          <Text color={theme.muted}> v{version}</Text>
        </Text>
        <Text color={theme.muted} wrap="truncate-end">
          синхронизация проекта и песочниц с анонимизацией
        </Text>
        <Box marginTop={1} flexDirection="column">
          <PathLine label="проект    " color={theme.project} value={config.projectRoot} />
          {summary.git ? (
            <>
              <PathLine label="worktree  " color={theme.project} value={config.worktreesDir} />
              <PathLine label="песочницы " color={theme.sandbox} value={config.sandboxesDir} />
            </>
          ) : (
            <PathLine label="песочница " color={theme.sandbox} value={config.profile.sandboxRoot} />
          )}
          <Text color={theme.muted} wrap="truncate-end">
            <SummaryText summary={summary} /> · замен {config.replacements.length}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

/** One-line header for small windows (and once files start moving). */
export function CompactHeader({ config, version, summary }: { config: AnonymusConfig; version: string; summary: PairsSummary }) {
  return (
    <Box flexShrink={0}>
      <Text wrap="truncate-middle">
        <Text bold color={theme.accent}>
          ▀▄ anonymus
        </Text>
        <Text color={theme.muted}> v{version} · </Text>
        <Text color={theme.project}>{path.basename(config.projectRoot)}</Text>
        <Text color={theme.muted}> · </Text>
        <SummaryText summary={summary} />
      </Text>
    </Box>
  );
}

function SummaryText({ summary }: { summary: PairsSummary }) {
  if (!summary.git) {
    return <Text color={theme.muted}>проект ⇄ песочница</Text>;
  }
  return (
    <Text>
      <Text color={theme.muted}>
        {summary.total} {plural(summary.total, "подпесочница", "подпесочницы", "подпесочниц")}
      </Text>
      {summary.attention > 0 && (
        <Text color={theme.error}>
          {" "}
          · {summary.attention} {plural(summary.attention, "требует", "требуют", "требуют")} внимания
        </Text>
      )}
    </Text>
  );
}

function PathLine({ label, color, value }: { label: string; color: string; value: string }) {
  return (
    <Box>
      <Box flexShrink={0}>
        <Text color={color}>{label}</Text>
      </Box>
      <Text wrap="truncate-middle">{value}</Text>
    </Box>
  );
}
