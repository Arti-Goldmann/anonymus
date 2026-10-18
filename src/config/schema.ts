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
 * One sandbox paired with the project. Only `default` exists today; the
 * branch-per-sandbox feature will add more profiles (each with its own git
 * branch of the main project) and a way to switch between them.
 */
export interface Profile {
  name: string;
  /** Absolute path of the sandbox root. */
  sandboxRoot: string;
  /** Git branch of the main project this sandbox belongs to (future). */
  branch?: string;
}

export interface AnonymusConfig {
  /** Absolute path of the main project root (the folder holding the config). */
  projectRoot: string;
  /** Absolute path of the config file itself. */
  configPath: string;
  profile: Profile;
  sync: SyncRules;
  replacements: ReplacementRule[];
}

export const CONFIG_FILENAMES = ["anonymus.yaml", ".anonymus.yaml"] as const;

/** Service directory inside the project root (state, trash, merge files). */
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
