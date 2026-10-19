import * as fs from "node:fs";
import * as path from "node:path";
import { isInside } from "../config/loader.js";
import { SERVICE_DIR, type AnonymusConfig, type Profile } from "../config/schema.js";

/** A git merge into this sub-sandbox's branch, run source by source. */
export interface MergeRun {
  /** All sources picked for this run, in order. */
  sources: string[];
  /** Sources already merged and committed. */
  done: string[];
  /** Source whose merge stopped on conflicts (git merge in progress), if any. */
  current: string | null;
}

/** One sync pair: a sub-sandbox and the git worktree of the project it mirrors. */
export interface SandboxEntry {
  name: string;
  /** Git branch checked out in the worktree. */
  branch: string;
  /** Worktree folder (absolute, outside the project). */
  worktree: string;
  /**
   * Random id also written into the worktree's own git folder
   * (`.git/worktrees/<x>/anonymus.json`). A worktree re-created by hand at the
   * same path has no such file, so it can never be mistaken for this one.
   */
  worktreeId: string;
  /** Sandbox folder (absolute). */
  sandbox: string;
  /** Branch and commit this sub-sandbox was created from (common ancestor for merging). */
  base: { branch: string; commit: string } | null;
  /**
   * The worktree was re-created or re-linked: its uncommitted work may be gone
   * while the sandbox still has it. Never reconcile automatically until the
   * user has looked (the reconcile screen recommends sandbox → project).
   */
  needsReview?: boolean;
  /** A git merge into this pair's branch that is not finished yet. */
  merge?: MergeRun | null;
  createdAt: string;
}

interface RegistryFile {
  version: 2;
  sandboxes: SandboxEntry[];
}

/** The registry on disk is of an older format (one shared project folder + stash). */
export class RegistryFormatError extends Error {
  constructor(readonly file: string) {
    super(
      `${file} — старый формат подпесочниц (переключение веток через stash). ` +
        "Теперь у каждой подпесочницы свой git worktree. Удалите этот файл и создайте подпесочницы заново " +
        "(клавиша n); папки песочниц и ветки git удаление файла не трогает."
    );
    this.name = "RegistryFormatError";
  }
}

/**
 * The sub-sandboxes of a git project, kept in `.anonymus/sandboxes.json` in
 * the main project. Every entry pairs a sandbox folder with its own worktree.
 */
export class Registry {
  readonly file: string;
  private data: RegistryFile;

  constructor(private readonly config: AnonymusConfig) {
    this.file = path.join(config.projectRoot, SERVICE_DIR, "sandboxes.json");
    this.data = this.read() ?? { version: 2, sandboxes: [] };
  }

  private read(): RegistryFile | null {
    let parsed: { version?: number; sandboxes?: unknown };
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return null;
    }
    if (parsed.version !== 2) {
      throw new RegistryFormatError(this.file);
    }
    return { version: 2, sandboxes: Array.isArray(parsed.sandboxes) ? (parsed.sandboxes as SandboxEntry[]) : [] };
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
    fs.renameSync(tmp, this.file);
  }

  list(): readonly SandboxEntry[] {
    return this.data.sandboxes;
  }

  get(name: string): SandboxEntry | undefined {
    return this.data.sandboxes.find((s) => s.name === name);
  }

  add(entry: Omit<SandboxEntry, "createdAt">): SandboxEntry {
    const created: SandboxEntry = { ...entry, createdAt: new Date().toISOString() };
    this.data.sandboxes.push(created);
    return created;
  }

  remove(name: string): void {
    this.data.sandboxes = this.data.sandboxes.filter((s) => s.name !== name);
  }

  /** The sync profile for an entry, as SyncEngine expects it. */
  profileOf(entry: SandboxEntry): Profile {
    return { name: entry.name, sandboxRoot: entry.sandbox, projectRoot: entry.worktree, branch: entry.branch };
  }

  /**
   * Folders that would make two pairs sync into each other or into the
   * project: problems are returned as messages (empty when all is fine).
   */
  overlaps(): string[] {
    const problems: string[] = [];
    const list = this.data.sandboxes;
    const project = this.config.projectRoot;
    for (const e of list) {
      for (const [label, dir] of [
        ["worktree", e.worktree],
        ["песочница", e.sandbox],
      ] as const) {
        if (isInside(dir, project) || isInside(project, dir)) {
          problems.push(`«${e.name}»: ${label} ${dir} пересекается с папкой проекта`);
        }
      }
      if (isInside(e.sandbox, e.worktree) || isInside(e.worktree, e.sandbox)) {
        problems.push(`«${e.name}»: песочница и worktree лежат одна в другой`);
      }
    }
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        const pairs: [string, string, string][] = [
          [a.worktree, b.worktree, "общий worktree"],
          [a.sandbox, b.sandbox, "общая песочница"],
          [a.sandbox, b.worktree, "песочница одной — worktree другой"],
          [a.worktree, b.sandbox, "worktree одной — песочница другой"],
        ];
        for (const [x, y, what] of pairs) {
          if (isInside(x, y) || isInside(y, x)) {
            problems.push(`«${a.name}» и «${b.name}»: ${what} (${x})`);
          }
        }
        if (a.branch === b.branch) {
          problems.push(`«${a.name}» и «${b.name}»: одна ветка ${a.branch}`);
        }
      }
    }
    return problems;
  }
}
