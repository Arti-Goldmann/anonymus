import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import iconv from "iconv-lite";
import type { AnonymusConfig, ReplacementRule, SyncRules } from "../src/config/schema.js";
import { DEFAULT_BINARY } from "../src/config/schema.js";
import { SyncEngine } from "../src/core/engine.js";

export interface Bench {
  root: string;
  project: string;
  sandbox: string;
  write(side: "project" | "sandbox", rel: string, content: string | Buffer): void;
  writeWin1251(side: "project" | "sandbox", rel: string, text: string): void;
  read(side: "project" | "sandbox", rel: string): string | null;
  readBytes(side: "project" | "sandbox", rel: string): Buffer | null;
  exists(side: "project" | "sandbox", rel: string): boolean;
  remove(side: "project" | "sandbox", rel: string): void;
  engine(overrides?: Partial<SyncRules>, replacements?: ReplacementRule[]): SyncEngine;
  config(overrides?: Partial<SyncRules>, replacements?: ReplacementRule[]): AnonymusConfig;
  /** Make the project a git repo with one commit of everything in it. */
  gitInit(): void;
  git(...args: string[]): string;
  /** git in another folder (a worktree). */
  gitIn(dir: string, ...args: string[]): string;
  cleanup(): void;
}

export const REPLACEMENTS: ReplacementRule[] = [
  { real: "BIGcorpProject", placeholder: "MyProject", variants: "auto" },
  { real: "romashka.ru", placeholder: "example.com", variants: "exact" },
];

export function makeBench(): Bench {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anonymus-test-"));
  const project = path.join(root, "proj");
  const sandbox = path.join(root, "sandbox");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(sandbox, { recursive: true });
  const dir = (side: "project" | "sandbox") => (side === "project" ? project : sandbox);
  const abs = (side: "project" | "sandbox", rel: string) => path.join(dir(side), ...rel.split("/"));

  return {
    root,
    project,
    sandbox,
    write(side, rel, content) {
      fs.mkdirSync(path.dirname(abs(side, rel)), { recursive: true });
      fs.writeFileSync(abs(side, rel), content);
    },
    writeWin1251(side, rel, text) {
      this.write(side, rel, iconv.encode(text, "win1251"));
    },
    read(side, rel) {
      return fs.existsSync(abs(side, rel)) ? fs.readFileSync(abs(side, rel), "utf8") : null;
    },
    readBytes(side, rel) {
      return fs.existsSync(abs(side, rel)) ? fs.readFileSync(abs(side, rel)) : null;
    },
    exists(side, rel) {
      return fs.existsSync(abs(side, rel));
    },
    remove(side, rel) {
      fs.rmSync(abs(side, rel), { force: true });
    },
    engine(overrides = {}, replacements = REPLACEMENTS) {
      return new SyncEngine(this.config(overrides, replacements));
    },
    config(overrides = {}, replacements = REPLACEMENTS) {
      return {
        projectRoot: project,
        configPath: path.join(project, "anonymus.yaml"),
        profile: { name: "default", sandboxRoot: sandbox },
        sandboxesDir: path.join(root, "sandboxes"),
        worktreesDir: path.join(root, "proj.worktrees"),
        sync: {
          include: ["**"],
          exclude: [],
          binary: DEFAULT_BINARY,
          encoding: "auto",
          sandboxEncoding: "keep",
          poll: false,
          debounceMs: 30,
          ...overrides,
        },
        replacements,
      };
    },
    git(...args: string[]) {
      return execFileSync("git", args, { cwd: project, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    },
    gitIn(dir: string, ...args: string[]) {
      return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    },
    gitInit() {
      this.git("init", "--quiet", "--initial-branch=master");
      this.git("config", "user.name", "test");
      this.git("config", "user.email", "test@example.com");
      this.git("config", "core.autocrlf", "false");
      this.git("add", "-A");
      this.git("commit", "--quiet", "-m", "initial");
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
