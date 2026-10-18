import * as fs from "node:fs";
import type { FileStatus, Kind, PathError, SyncEngine } from "./engine.js";

export interface ScanResult {
  statuses: FileStatus[];
  pathErrors: PathError[];
  counts: Record<Kind, number>;
  /** Number of synced-able files present on each side. */
  projectFiles: number;
  sandboxFiles: number;
  sandboxExists: boolean;
  /** True when every file is synced and there are no path problems. */
  clean: boolean;
}

export type ScanProgress = (done: number, total: number) => void;

const ZERO_COUNTS: Record<Kind, number> = {
  synced: 0,
  "only-project": 0,
  "only-sandbox": 0,
  "project-changed": 0,
  "sandbox-changed": 0,
  "both-changed": 0,
  "deleted-in-project": 0,
  "deleted-in-sandbox": 0,
  "differs-unknown": 0,
  gone: 0,
  ignored: 0,
  error: 0,
};

/** Yield to the event loop now and then so the UI spinner keeps moving. */
const tick = () => new Promise<void>((r) => setImmediate(r));

/** Compare both trees (taking replacements into account) file by file. */
export async function scan(engine: SyncEngine, onProgress?: ScanProgress): Promise<ScanResult> {
  const { canonicals, pathErrors } = engine.listCandidates();
  const statuses: FileStatus[] = [];
  const counts = { ...ZERO_COUNTS };
  let projectFiles = 0;
  let sandboxFiles = 0;

  for (let i = 0; i < canonicals.length; i++) {
    const status = engine.classify(canonicals[i]);
    counts[status.kind]++;
    if (status.kind !== "ignored" && status.kind !== "gone") {
      statuses.push(status);
    }
    if (fs.existsSync(engine.abs("project", status.canonical))) {
      projectFiles++;
    }
    if (fs.existsSync(engine.abs("sandbox", status.canonical))) {
      sandboxFiles++;
    }
    if (i % 50 === 0) {
      onProgress?.(i, canonicals.length);
      await tick();
    }
  }
  onProgress?.(canonicals.length, canonicals.length);

  const clean =
    pathErrors.length === 0 && statuses.every((s) => s.kind === "synced");
  return {
    statuses,
    pathErrors,
    counts,
    projectFiles,
    sandboxFiles,
    sandboxExists: fs.existsSync(engine.sandboxRoot),
    clean,
  };
}

/** Human-readable label for every kind. */
export const KIND_LABEL: Record<Kind, string> = {
  synced: "совпадают",
  "only-project": "только в проекте",
  "only-sandbox": "только в песочнице",
  "project-changed": "изменены в проекте",
  "sandbox-changed": "изменены в песочнице",
  "both-changed": "изменены с обеих сторон",
  "deleted-in-project": "удалены в проекте",
  "deleted-in-sandbox": "удалены в песочнице",
  "differs-unknown": "различаются (нет истории)",
  gone: "исчезли с обеих сторон",
  ignored: "не синхронизируются",
  error: "ошибки путей",
};
