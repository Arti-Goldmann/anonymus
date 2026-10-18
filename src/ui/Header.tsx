import * as path from "node:path";
import { Box, Text } from "ink";
import type { AnonymusConfig } from "../config/schema.js";
import { MASCOT_SPRITE, renderMascot } from "./mascot.js";
import { theme } from "./theme.js";

const MASCOT_LINES = renderMascot();

/** Rows taken by the full header (mascot + blank line below). */
export const HEADER_ROWS = MASCOT_SPRITE.length / 2 + 1;
/** Narrowest window the full header fits into. */
export const HEADER_MIN_COLUMNS = 90;

/** Full header: mascot on the left, name and the two synced folders on the right. */
export function Header({ config, version }: { config: AnonymusConfig; version: string }) {
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
          синхронизация проекта и песочницы с анонимизацией
        </Text>
        <Box marginTop={1} flexDirection="column">
          <PathLine label="проект    " color={theme.project} value={config.projectRoot} />
          <PathLine label="песочница " color={theme.sandbox} value={config.profile.sandboxRoot} />
          <Text color={theme.muted} wrap="truncate-end">
            подпесочница {config.profile.name}
            {config.profile.branch ? ` ⎇ ${config.profile.branch}` : ""} · замен {config.replacements.length}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

/** One-line header for small windows (and while live sync is running). */
export function CompactHeader({ config, version }: { config: AnonymusConfig; version: string }) {
  return (
    <Box flexShrink={0}>
      <Text wrap="truncate-middle">
        <Text bold color={theme.accent}>
          ▀▄ anonymus
        </Text>
        <Text color={theme.muted}> v{version} · </Text>
        <Text bold>{config.profile.name}</Text>
        {config.profile.branch && <Text color={theme.muted}> ⎇ {config.profile.branch}</Text>}
        <Text color={theme.muted}> · </Text>
        <Text color={theme.project}>{path.basename(config.projectRoot)}</Text>
        <Text color={theme.muted}> ⇄ </Text>
        <Text color={theme.sandbox}>{path.basename(config.profile.sandboxRoot)}</Text>
      </Text>
    </Box>
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
