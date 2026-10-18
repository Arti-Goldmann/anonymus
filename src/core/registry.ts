import * as fs from "node:fs";
import * as path from "node:path";
import { SERVICE_DIR, type AnonymusConfig, type Profile } from "../config/schema.js";

/** One sub-sandbox as stored on disk. */
export interface SandboxEntry {
  name: string;
  /** Sandbox folder, relative to the project root (or absolute on another drive). */
  path: string;
  /** Project branch this sandbox belongs to (null when the project is not a git repo). */
  branch: string | null;
  /** Label of the git stash holding this branch's uncommitted work, if any. */
  stash: string | null;
  createdAt: string;
}

interface RegistryFile {
  version: 1;
  active: string;
  sandboxes: SandboxEntry[];
}

/**
 * The list of sub-sandboxes and which one is active, kept in
 * `.anonymus/sandboxes.json` inside the project. Created on first use from the
 * `sandbox:` setting of anonymus.yaml (profile `default`), so existing configs
 * keep working unchanged.
 */
export class Registry {
  private readonly file: string;
  private data: RegistryFile;

  constructor(private readonly config: AnonymusConfig, currentBranch: string | null) {
    this.file = path.join(config.projectRoot, SERVICE_DIR, "sandboxes.json");
    this.data = this.read() ?? {
      version: 1,
      active: "default",
      sandboxes: [
        {
          name: "default",
          path: this.toStored(config.profile.sandboxRoot),
          branch: currentBranch,
          stash: null,
          createdAt: new Date().toISOString(),
        },
      ],
    };
    if (!this.get(this.data.active)) {
      this.data.active = this.data.sandboxes[0]?.name ?? "default";
    }
  }

  private read(): RegistryFile | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as RegistryFile;
      return parsed.version === 1 && Array.isArray(parsed.sandboxes) && parsed.sandboxes.length > 0
        ? parsed
        : null;
    } catch {
      return null;
    }
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
    fs.renameSync(tmp, this.file);
  }

  /** Paths are stored relative to the project when possible (portable). */
  private toStored(abs: string): string {
    const rel = path.relative(this.config.projectRoot, abs);
    return path.isAbsolute(rel) ? abs : rel.split(path.sep).join("/");
  }

  absPath(entry: SandboxEntry): string {
    return path.resolve(this.config.projectRoot, entry.path);
  }

  list(): readonly SandboxEntry[] {
    return this.data.sandboxes;
  }

  get(name: string): SandboxEntry | undefined {
    return this.data.sandboxes.find((s) => s.name === name);
  }

  get active(): SandboxEntry {
    return this.get(this.data.active)!;
  }

  setActive(name: string): void {
    if (!this.get(name)) {
      throw new Error(`нет подпесочницы «${name}»`);
    }
    this.data.active = name;
  }

  add(entry: { name: string; absPath: string; branch: string | null }): SandboxEntry {
    const created: SandboxEntry = {
      name: entry.name,
      path: this.toStored(entry.absPath),
      branch: entry.branch,
      stash: null,
      createdAt: new Date().toISOString(),
    };
    this.data.sandboxes.push(created);
    return created;
  }

  remove(name: string): void {
    this.data.sandboxes = this.data.sandboxes.filter((s) => s.name !== name);
  }

  /** The sync profile for an entry, as SyncEngine expects it. */
  profileOf(entry: SandboxEntry): Profile {
    return { name: entry.name, sandboxRoot: this.absPath(entry), branch: entry.branch ?? undefined };
  }
}
