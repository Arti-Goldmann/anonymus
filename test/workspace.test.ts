import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import iconv from "iconv-lite";
import { acquireLock } from "../src/core/lock.js";
import { RegistryFormatError } from "../src/core/registry.js";
import { Workspace } from "../src/core/workspace.js";
import { makeBench, type Bench } from "./helpers.js";
import { livePair, reconcilePair, waitFor } from "./pairs.js";

describe("Workspace: a git worktree per sub-sandbox", () => {
  let bench: Bench;
  const stops: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(stops.splice(0).map((s) => s()));
    bench?.cleanup();
  });

  function setup(): Workspace {
    bench = makeBench();
    bench.write("project", "BIGcorpProject/main.c", "int v = 1; // BIGcorpProject\n");
    bench.writeWin1251("project", "BIGcorpProject/ru.c", "// Комментарий BIGcorpProject\r\nint x;\r\n");
    bench.write("project", ".gitignore", "anonymus.yaml\n.anonymus/\n");
    bench.gitInit();
    return new Workspace(bench.config());
  }

  it("starts without pairs; the main folder is never synced", async () => {
    const ws = setup();
    expect(ws.gitEnabled).toBe(true);
    expect(ws.pairs()).toEqual([]);
    expect(ws.problems()).toEqual([]);
  });

  it("creates a branch, its worktree with the ownership mark and an anonymized sandbox folder", async () => {
    const ws = setup();
    const entry = await ws.create("BIGcorpProject-uart");

    expect(bench.git("branch", "--show-current")).toBe("master"); // main folder untouched
    expect(entry.branch).toBe("BIGcorpProject-uart");
    expect(entry.base).toEqual({ branch: "master", commit: bench.git("rev-parse", "master") });
    expect(entry.worktree).toBe(path.join(bench.root, "proj.worktrees", "BIGcorpProject-uart"));
    expect(bench.gitIn(entry.worktree, "branch", "--show-current")).toBe("BIGcorpProject-uart");
    // The folder the agent sees carries the placeholder, not the real name.
    expect(path.basename(entry.sandbox)).toBe("MyProject-uart");
    expect(ws.check(entry.name, false)).toBeNull();

    await reconcilePair(ws, entry.name);
    expect(fs.readFileSync(path.join(entry.sandbox, "MyProject", "main.c"), "utf8")).toBe("int v = 1; // MyProject\n");
    expect(iconv.decode(fs.readFileSync(path.join(entry.sandbox, "MyProject", "ru.c")), "win1251")).toBe(
      "// Комментарий MyProject\r\nint x;\r\n"
    );
    // The worktree's `.git` is a file: it must never reach the sandbox.
    expect(fs.statSync(path.join(entry.worktree, ".git")).isFile()).toBe(true);
    expect(fs.existsSync(path.join(entry.sandbox, ".git"))).toBe(false);
  });

  it("takes an existing branch that is not checked out anywhere", async () => {
    const ws = setup();
    bench.git("branch", "old-feature");
    expect(ws.isExistingBranch("old-feature")).toBe(true);
    const entry = await ws.create("old-feature");
    expect(entry.base).toBeNull();
    expect(bench.gitIn(entry.worktree, "branch", "--show-current")).toBe("old-feature");
    // master is checked out in the main folder: git cannot give it to a worktree.
    expect(ws.validateNewName("master")).toMatch(/уже выбрана/);
  });

  it("rejects bad or duplicate names", async () => {
    const ws = setup();
    await ws.create("feature");
    expect(ws.validateNewName("bad name with ..")).toMatch(/не подходит/);
    expect(ws.validateNewName("feature")).toMatch(/уже есть/);
    expect(ws.validateNewName("ok-name")).toBeNull();
  });

  it("syncs several pairs at the same time, each with its own worktree", async () => {
    const ws = setup();
    const a = await ws.create("agent-a");
    const b = await ws.create("agent-b");
    const pa = await livePair(ws, "agent-a");
    const pb = await livePair(ws, "agent-b");
    stops.push(() => pa.syncer.stop(), () => pb.syncer.stop());

    fs.writeFileSync(path.join(a.sandbox, "MyProject", "main.c"), "int v = 2; // MyProject\n");
    fs.writeFileSync(path.join(b.sandbox, "MyProject", "new.c"), "// MyProject b\n");
    await waitFor(() => fs.existsSync(path.join(b.worktree, "BIGcorpProject", "new.c")));
    await waitFor(
      () => fs.readFileSync(path.join(a.worktree, "BIGcorpProject", "main.c"), "utf8") === "int v = 2; // BIGcorpProject\n"
    );
    // Independent: nothing crossed over, the main folder stayed as it was.
    expect(fs.readFileSync(path.join(b.worktree, "BIGcorpProject", "main.c"), "utf8")).toBe("int v = 1; // BIGcorpProject\n");
    expect(fs.existsSync(path.join(a.worktree, "BIGcorpProject", "new.c"))).toBe(false);
    expect(bench.read("project", "BIGcorpProject/main.c")).toBe("int v = 1; // BIGcorpProject\n");
    expect(bench.git("status", "--porcelain")).toBe("");
  });

  it("commits a pair's work in its worktree, without anonymus' own files", async () => {
    const ws = setup();
    const e = await ws.create("feature");
    fs.writeFileSync(path.join(e.worktree, "BIGcorpProject", "main.c"), "int v = 2;\n");
    expect(ws.commit("feature", "work")).toBe(true);
    expect(bench.git("log", "-1", "--format=%s", "feature")).toBe("work");
    expect(ws.commit("feature", "again")).toBe(false);
  });

  it("removes a pair: sandbox to the trash, worktree via git, branch kept", async () => {
    const ws = setup();
    const e = await ws.create("feature");
    await reconcilePair(ws, "feature");
    const { trashDir } = ws.remove("feature");
    expect(fs.existsSync(e.worktree)).toBe(false);
    expect(fs.existsSync(e.sandbox)).toBe(false);
    expect(fs.existsSync(path.join(trashDir, path.basename(e.sandbox), "MyProject", "main.c"))).toBe(true);
    expect(ws.pairs()).toEqual([]);
    expect(bench.git("branch", "--list", "feature")).toContain("feature");
    expect(bench.git("worktree", "list").split("\n")).toHaveLength(1);
  });

  it("refuses to remove a worktree with uncommitted work unless forced, then keeps a copy", async () => {
    const ws = setup();
    const e = await ws.create("feature");
    fs.writeFileSync(path.join(e.worktree, "BIGcorpProject", "main.c"), "int v = 9;\n");
    fs.writeFileSync(path.join(e.worktree, "BIGcorpProject", "new.c"), "// new\n");
    expect(ws.uncommitted("feature")).toHaveLength(2);
    expect(() => ws.remove("feature")).toThrow(/незакоммиченные изменения/);
    expect(fs.existsSync(e.worktree)).toBe(true);

    const { trashDir } = ws.remove("feature", { force: true });
    expect(fs.readFileSync(path.join(trashDir, "worktree", "BIGcorpProject", "main.c"), "utf8")).toBe("int v = 9;\n");
    expect(fs.readFileSync(path.join(trashDir, "worktree", "BIGcorpProject", "new.c"), "utf8")).toBe("// new\n");
    expect(fs.existsSync(e.worktree)).toBe(false);
  });

  it("refuses the old stash-based registry with a clear message", async () => {
    bench = makeBench();
    bench.write("project", "a.txt", "a\n");
    bench.gitInit();
    bench.write("project", ".anonymus/sandboxes.json", JSON.stringify({ version: 1, active: "default", sandboxes: [{}] }));
    expect(() => new Workspace(bench.config())).toThrow(RegistryFormatError);
  });

  it("allows only one running instance per project", async () => {
    bench = makeBench();
    const dir = path.join(bench.project, ".anonymus");
    const first = acquireLock(dir);
    expect("release" in first).toBe(true);
    // Simulate another live process holding the lock.
    fs.writeFileSync(path.join(dir, "lock"), String(process.ppid));
    expect(acquireLock(dir)).toEqual({ heldBy: process.ppid });
  });
});

describe("Workspace: submodules", () => {
  let bench: Bench;
  // Local submodules are cloned over the file protocol, which git refuses by default.
  const savedEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...savedEnv };
    bench?.cleanup();
  });

  function setup(): { ws: Workspace; lib: string } {
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow";
    process.env.GIT_CONFIG_VALUE_0 = "always";
    bench = makeBench();
    // The submodule's own repository.
    const lib = path.join(bench.root, "xml-lib");
    fs.mkdirSync(lib);
    fs.writeFileSync(path.join(lib, "TextBase.xml"), "<base owner=\"BIGcorpProject\"/>\n");
    const libGit = (...a: string[]) => bench.gitIn(lib, ...a);
    libGit("init", "--quiet", "--initial-branch=master");
    libGit("config", "user.name", "test");
    libGit("config", "user.email", "test@example.com");
    libGit("add", "-A");
    libGit("commit", "--quiet", "-m", "lib");

    bench.write("project", "BIGcorpProject/main.c", "int v = 1;\n");
    bench.write("project", ".gitignore", "anonymus.yaml\n.anonymus/\n");
    bench.gitInit();
    bench.git("submodule", "--quiet", "add", lib.split(path.sep).join("/"), "CoodEdit/xml_DB");
    bench.git("commit", "--quiet", "-m", "submodule");
    return { ws: new Workspace(bench.config()), lib };
  }

  it("checks out submodules in a new worktree, so they reach the sandbox", async () => {
    const { ws } = setup();
    const steps: string[] = [];
    const warnings: string[] = [];
    const e = await ws.create("feature", {}, (m) => steps.push(m), (m) => warnings.push(m));
    expect(warnings).toEqual([]);
    expect(steps.some((s) => s.includes("git submodule update --init --recursive"))).toBe(true);
    expect(fs.readFileSync(path.join(e.worktree, "CoodEdit", "xml_DB", "TextBase.xml"), "utf8")).toContain("BIGcorpProject");

    await reconcilePair(ws, "feature");
    expect(fs.readFileSync(path.join(e.sandbox, "CoodEdit", "xml_DB", "TextBase.xml"), "utf8")).toBe(
      '<base owner="MyProject"/>\n'
    );
    // The submodule's `.git` file stays on the project side.
    expect(fs.existsSync(path.join(e.sandbox, "CoodEdit", "xml_DB", ".git"))).toBe(false);

    // An edit inside the submodule counts as uncommitted work of the pair.
    fs.writeFileSync(path.join(e.worktree, "CoodEdit", "xml_DB", "TextBase.xml"), "<base edited/>\n");
    expect(() => ws.remove("feature")).toThrow(/незакоммиченные изменения/);

    // git refuses `worktree remove` with submodules unless forced — removing the pair still works,
    // and the edited submodule is kept in the trash.
    const { trashDir } = ws.remove("feature", { force: true });
    expect(fs.existsSync(e.worktree)).toBe(false);
    expect(bench.git("worktree", "list").split("\n")).toHaveLength(1);
    expect(fs.readFileSync(path.join(trashDir, "worktree", "CoodEdit", "xml_DB", "TextBase.xml"), "utf8")).toBe(
      "<base edited/>\n"
    );
  });

  it("removes a clean pair with submodules without asking for force", async () => {
    const { ws } = setup();
    const e = await ws.create("feature");
    ws.remove("feature");
    expect(fs.existsSync(e.worktree)).toBe(false);
  });

  it("still creates the pair when a submodule cannot be fetched, and says how to retry", async () => {
    const { ws, lib } = setup();
    fs.rmSync(lib, { recursive: true, force: true }); // the submodule's repository is unreachable
    const warnings: string[] = [];
    const e = await ws.create("feature", {}, () => {}, (m) => warnings.push(m));
    expect(warnings[0]).toMatch(/подмодули не скачались/);
    expect(warnings[0]).toContain("submodule update --init --recursive");
    expect(ws.check("feature", false)).toBeNull();
    expect(fs.existsSync(e.sandbox)).toBe(true);
  });
});

describe("Workspace without git", () => {
  let bench: Bench;
  afterEach(() => bench?.cleanup());

  it("keeps working with the single pair: project folder ⇄ sandbox", async () => {
    bench = makeBench();
    bench.write("project", "BIGcorpProject/main.c", "int v = 1; // BIGcorpProject\n");
    const ws = new Workspace(bench.config());
    expect(ws.gitEnabled).toBe(false);
    expect(ws.pairs().map((p) => [p.name, p.projectDir])).toEqual([["default", bench.project]]);
    expect(ws.validateNewName("x")).toMatch(/не является git/);
    await reconcilePair(ws, "default");
    expect(bench.read("sandbox", "MyProject/main.c")).toBe("int v = 1; // MyProject\n");
  });
});
