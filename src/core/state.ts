import * as fs from "node:fs";
import * as path from "node:path";
import { SERVICE_DIR } from "../config/schema.js";
import { writeFileAtomic } from "./fileio.js";

/** What both sides looked like the last time a file was in sync. */
export interface SyncEntry {
  /** Project-side relative path (= the canonical key). */
  projectPath: string;
  sandboxPath: string;
  projectHash: string;
  sandboxHash: string;
  binary: boolean;
  syncedAt: string;
}

interface StateFile {
  version: 1;
  profile: string;
  entries: Record<string, SyncEntry>;
}

/**
 * Per-profile sync state, stored in the PROJECT (never in the sandbox):
 *
 *   .anonymus/profiles/<profile>/state.json   hashes of both sides per file
 *   .anonymus/profiles/<profile>/base/<hash>  sandbox bytes at the last sync,
 *                                             the common ancestor for 3-way merge
 *
 * The base snapshot is keyed by the sandbox hash recorded in the entry, so an
 * entry and its base can never drift apart.
 */
export class StateStore {
  readonly dir: string;
  private readonly baseDir: string;
  private readonly file: string;
  private entries = new Map<string, SyncEntry>();

  constructor(projectRoot: string, readonly profile: string) {
    this.dir = path.join(projectRoot, SERVICE_DIR, "profiles", profile);
    this.baseDir = path.join(this.dir, "base");
    this.file = path.join(this.dir, "state.json");
    this.load();
  }

  private load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as StateFile;
      if (parsed.version === 1 && parsed.entries) {
        this.entries = new Map(Object.entries(parsed.entries));
      }
    } catch {
      this.entries = new Map();
    }
  }

  /** Persist atomically (temp file + rename) so a crash never truncates it. */
  save(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const data: StateFile = {
      version: 1,
      profile: this.profile,
      entries: Object.fromEntries([...this.entries].sort(([a], [b]) => a.localeCompare(b))),
    };
    writeFileAtomic(this.file, JSON.stringify(data, null, 2));
  }

  get size(): number {
    return this.entries.size;
  }

  get(canonical: string): SyncEntry | undefined {
    return this.entries.get(canonical);
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }

  /** Record a synced file; `sandboxBytes` becomes its merge base. */
  set(entry: SyncEntry, sandboxBytes: Uint8Array | null): void {
    this.entries.set(entry.projectPath, entry);
    if (sandboxBytes && !entry.binary) {
      const basePath = path.join(this.baseDir, entry.sandboxHash);
      if (!fs.existsSync(basePath)) {
        fs.mkdirSync(this.baseDir, { recursive: true });
        fs.writeFileSync(basePath, sandboxBytes);
      }
    }
  }

  delete(canonical: string): void {
    this.entries.delete(canonical);
  }

  /** Sandbox bytes at the last sync of this file, if a snapshot exists. */
  getBase(canonical: string): Buffer | null {
    const entry = this.entries.get(canonical);
    if (!entry || entry.binary) {
      return null;
    }
    try {
      return fs.readFileSync(path.join(this.baseDir, entry.sandboxHash));
    } catch {
      return null;
    }
  }

  /** Drop base snapshots no entry refers to any more. */
  collectGarbage(): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.baseDir);
    } catch {
      return;
    }
    const used = new Set([...this.entries.values()].map((e) => e.sandboxHash));
    for (const name of names) {
      if (!used.has(name)) {
        fs.rmSync(path.join(this.baseDir, name), { force: true });
      }
    }
  }
}
