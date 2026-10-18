import ignoreModule, { type Ignore } from "ignore";
import { SERVICE_DIR, type SyncRules } from "../config/schema.js";

// CJS package: at runtime the default import is the factory itself, but under
// NodeNext the typings expose it as `.default` (which also exists at runtime).
const ignore = ignoreModule.default;

/** Never synced, whatever the config says. */
const ALWAYS_EXCLUDED = [".git/", `${SERVICE_DIR}/`, "anonymus.yaml", ".anonymus.yaml"];

/**
 * Decides which files take part in the sync. All patterns use `.gitignore`
 * semantics (via the `ignore` package) and are matched against the
 * CANONICAL path — the POSIX relative path in the main project:
 *
 *   .venv*        any file/dir whose name starts with ".venv", at any depth
 *   .venv         only entries named exactly ".venv" (not ".venv-ubuntu")
 *   /build        only "build" in the project root (not "src/build")
 *   src/gen/a.c   exactly this file
 *   logs/         directories only
 *   !keep.txt     re-include something an earlier pattern excluded
 */
export class SyncFilter {
  private readonly include: Ignore;
  private readonly exclude: Ignore;
  private readonly binary: Ignore;

  constructor(rules: Pick<SyncRules, "include" | "exclude" | "binary">) {
    this.include = ignore().add(rules.include);
    this.exclude = ignore().add([...ALWAYS_EXCLUDED, ...rules.exclude]);
    this.binary = ignore().add(rules.binary);
  }

  /** Should this file be synced? */
  isSynced(canonicalPath: string): boolean {
    if (!isValidRelative(canonicalPath)) {
      return false;
    }
    return this.include.ignores(canonicalPath) && !this.exclude.ignores(canonicalPath);
  }

  /**
   * Can a whole directory be skipped while walking / watching? Only `exclude`
   * prunes: an include pattern like `CMakeLists.txt` may match anywhere, so
   * no directory can be ruled out by `include` alone.
   */
  isDirExcluded(canonicalDir: string): boolean {
    if (!isValidRelative(canonicalDir)) {
      return false;
    }
    return this.exclude.ignores(canonicalDir + "/");
  }

  /** Copy byte-for-byte, without replacements? */
  isBinary(canonicalPath: string): boolean {
    return isValidRelative(canonicalPath) && this.binary.ignores(canonicalPath);
  }
}

/** `ignore` throws on "", "./x", "../x" and absolute paths. */
function isValidRelative(p: string): boolean {
  return p.length > 0 && !p.startsWith("/") && !p.startsWith("./") && !p.startsWith("../") && p !== "." && p !== "..";
}
