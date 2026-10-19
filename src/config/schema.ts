/**
 * Types for `anonymus.yaml` — the config that lives in the root of the main
 * (real) project.
 */

import type { EncodingSetting } from "../core/encoding.js";

export type VariantMode = "auto" | "exact";

export interface ReplacementRule {
  /** Real (sensitive) value, present in the main project. */
  real: string;
  /** Neutral placeholder used in the sandbox. */
  placeholder: string;
  /** How to expand the pair into case variants. Defaults to "auto". */
  variants: VariantMode;
  description?: string;
}

/** Which files take part in the sync. Patterns use `.gitignore` syntax. */
export interface SyncRules {
  /** Files to sync. Required and explicit; `**` means "everything". */
  include: string[];
  /** Files that must never be synced (evaluated after `include`). */
  exclude: string[];
  /** Files copied byte-for-byte, without replacements. */
  binary: string[];
  /** Encoding of project files (and of sandbox files when `keep`). */
  encoding: EncodingSetting;
  /**
   * `keep` — sandbox files use the same encoding as their project originals;
   * `utf8` — sandbox files are always UTF-8 (agents handle it best), project
   * files are still written back in their own encoding (e.g. win1251).
   */
  sandboxEncoding: "keep" | "utf8";
  /** Use filesystem polling instead of native events (Docker bind mounts). */
  poll: boolean;
  /** Quiet period before a changed file is processed. */
  debounceMs: number;
}

/**
 * One sync pair. In a git project every sub-sandbox is paired with its own
 * git worktree of the project (see core/workspace.ts) and all pairs sync at
 * once; without git the single pair is the project folder itself.
 */
export interface Profile {
  name: string;
  /** Absolute path of the sandbox root. */
  sandboxRoot: string;
  /** Project side of the pair: the worktree (defaults to the main project folder). */
  projectRoot?: string;
  /** Git branch checked out in that worktree. */
  branch?: string;
}

export interface AnonymusConfig {
  /**
   * Absolute path of the main project root: the folder holding the config and
   * `.anonymus/` (state, trash, journal of all pairs).
   */
  projectRoot: string;
  /** Absolute path of the config file itself. */
  configPath: string;
  profile: Profile;
  /** Folder new sub-sandboxes are created in. */
  sandboxesDir: string;
  /** Folder the git worktrees of sub-sandboxes are created in (outside the project). */
  worktreesDir: string;
  sync: SyncRules;
  replacements: ReplacementRule[];
}

export const CONFIG_FILENAMES = ["anonymus.yaml", ".anonymus.yaml"] as const;

/** Service directory inside the main project root (state, trash, merge files). */
export const SERVICE_DIR = ".anonymus";

export const DEFAULT_BINARY: string[] = [
  "*.png", "*.jpg", "*.jpeg", "*.gif", "*.webp", "*.bmp", "*.ico", "*.tiff",
  "*.pdf",
  "*.zip", "*.tar", "*.gz", "*.7z", "*.rar",
  "*.woff", "*.woff2", "*.ttf", "*.otf", "*.eot",
  "*.mp3", "*.mp4", "*.wav", "*.webm",
  "*.bin", "*.hex", "*.elf", "*.o", "*.a", "*.so", "*.dll", "*.exe", "*.lib",
  "*.wasm",
];
