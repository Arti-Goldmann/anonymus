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
    const { trashDir } = await ws.remove("feature");
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
    await expect(ws.remove("feature")).rejects.toThrow(/незакоммиченные изменения/);
    expect(fs.existsSync(e.worktree)).toBe(true);

    const { trashDir } = await ws.remove("feature", { force: true });
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

describe("Workspace: worktrees inside the project, removal on Windows", () => {
  let bench: Bench;
  afterEach(() => bench?.cleanup());

  function setup(inside: boolean): Workspace {
    bench = makeBench();
    bench.write("project", "BIGcorpProject/main.c", "int v = 1; // BIGcorpProject\n");
    bench.write("project", ".gitignore", "anonymus.yaml\n.anonymus/\n");
    bench.gitInit();
    const config = bench.config();
    return new Workspace(inside ? { ...config, worktreesDir: path.join(bench.project, ".worktrees") } : config);
  }

  it("keeps worktrees in the project's .worktrees, hidden from git without touching .gitignore", async () => {
    const ws = setup(true);
    const e = await ws.create("feature");
    expect(e.worktree).toBe(path.join(bench.project, ".worktrees", "feature"));
    expect(ws.problems()).toEqual([]);
    expect(ws.check("feature", false)).toBeNull();
    // The main folder stays clean in git; only the local exclude list knows the folder.
    expect(bench.git("status", "--porcelain")).toBe("");
    expect(bench.read("project", ".gitignore")).toBe("anonymus.yaml\n.anonymus/\n");
    expect(fs.readFileSync(path.join(bench.project, ".git", "info", "exclude"), "utf8")).toContain("/.worktrees/");

    await reconcilePair(ws, "feature");
    expect(fs.readFileSync(path.join(e.sandbox, "MyProject", "main.c"), "utf8")).toBe("int v = 1; // MyProject\n");
    await ws.create("second"); // the exclude line is not added twice
    expect(fs.readFileSync(path.join(bench.project, ".git", "info", "exclude"), "utf8").split("/.worktrees/")).toHaveLength(2);

    await ws.remove("feature");
    expect(fs.existsSync(e.worktree)).toBe(false);
  });

  it("finishes a worktree whose files were deleted while its folder stayed (Windows)", async () => {
    const ws = setup(false);
    const e = await ws.create("feature");
    // What a removal blocked by another program leaves behind: an empty folder, still registered.
    for (const name of fs.readdirSync(e.worktree)) {
      fs.rmSync(path.join(e.worktree, name), { recursive: true, force: true });
    }
    expect(ws.check("feature", false)?.code).toBe("not-worktree");
    await ws.remove("feature");
    expect(fs.existsSync(e.worktree)).toBe(false);
    expect(bench.git("worktree", "list").split("\n")).toHaveLength(1);
    expect(ws.pairs()).toEqual([]);
  });

  it.runIf(process.platform === "win32")("waits while another program holds the worktree folder open", async () => {
    const ws = setup(false);
    const e = await ws.create("feature");
    // A process whose current folder is the worktree keeps Windows from deleting it.
    const { spawn } = await import("node:child_process");
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 2500)"], { cwd: e.worktree });
    await new Promise((r) => setTimeout(r, 300));
    const steps: string[] = [];
    await ws.remove("feature", {}, (m) => steps.push(m));
    expect(steps.some((s) => s.includes("занята другой программой"))).toBe(true);
    expect(fs.existsSync(e.worktree)).toBe(false);
    expect(bench.git("worktree", "list").split("\n")).toHaveLength(1);
    holder.kill();
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

  it("copies submodules from the main folder — no network needed — so they reach the sandbox", async () => {
    const { ws, lib } = setup();
    const libUrl = bench.gitIn(path.join(bench.project, "CoodEdit", "xml_DB"), "remote", "get-url", "origin");
    fs.renameSync(lib, `${lib}-offline`); // the submodule's server is unreachable
    const steps: string[] = [];
    const warnings: string[] = [];
    const e = await ws.create("feature", {}, (m) => steps.push(m), (m) => warnings.push(m));
    expect(warnings).toEqual([]);
    expect(steps.some((s) => s.includes("копирую из основной папки"))).toBe(true);
    const sub = path.join(e.worktree, "CoodEdit", "xml_DB");
    expect(fs.readFileSync(path.join(sub, "TextBase.xml"), "utf8")).toContain("BIGcorpProject");
    // An independent clone that fetches from the real server, not from the main folder.
    expect(bench.gitIn(sub, "remote", "get-url", "origin")).toBe(libUrl);
    const subGitDir = bench.gitIn(sub, "rev-parse", "--absolute-git-dir");
    expect(fs.existsSync(path.join(subGitDir, "objects", "info", "alternates"))).toBe(false);
    // The repository's own submodule settings are left as they were.
    expect(bench.git("config", "--get", "submodule.CoodEdit/xml_DB.url")).toBe(libUrl);
    fs.renameSync(`${lib}-offline`, lib);

    await reconcilePair(ws, "feature");
    expect(fs.readFileSync(path.join(e.sandbox, "CoodEdit", "xml_DB", "TextBase.xml"), "utf8")).toBe(
      '<base owner="MyProject"/>\n'
    );
    // The submodule's `.git` file stays on the project side.
    expect(fs.existsSync(path.join(e.sandbox, "CoodEdit", "xml_DB", ".git"))).toBe(false);

    // An edit inside the submodule counts as uncommitted work of the pair.
    fs.writeFileSync(path.join(e.worktree, "CoodEdit", "xml_DB", "TextBase.xml"), "<base edited/>\n");
    await expect(ws.remove("feature")).rejects.toThrow(/незакоммиченные изменения/);

    // git refuses `worktree remove` with submodules unless forced — removing the pair still works,
    // and the edited submodule is kept in the trash.
    const { trashDir } = await ws.remove("feature", { force: true });
    expect(fs.existsSync(e.worktree)).toBe(false);
    expect(bench.git("worktree", "list").split("\n")).toHaveLength(1);
    expect(fs.readFileSync(path.join(trashDir, "worktree", "CoodEdit", "xml_DB", "TextBase.xml"), "utf8")).toBe(
      "<base edited/>\n"
    );
  });

  it("removes a clean pair with submodules without asking for force", async () => {
    const { ws } = setup();
    const e = await ws.create("feature");
    await ws.remove("feature");
    expect(fs.existsSync(e.worktree)).toBe(false);
  });

  it("falls back to the network when the main folder has no copy of the submodule", async () => {
    const { ws } = setup();
    bench.git("submodule", "deinit", "--quiet", "--force", "--", "CoodEdit/xml_DB");
    const steps: string[] = [];
    const e = await ws.create("feature", {}, (m) => steps.push(m));
    expect(steps.some((s) => s.includes("скачиваю по сети"))).toBe(true);
    expect(fs.existsSync(path.join(e.worktree, "CoodEdit", "xml_DB", "TextBase.xml"))).toBe(true);
  });

  it("still creates the pair when a submodule cannot be fetched, and says how to retry", async () => {
    const { ws, lib } = setup();
    bench.git("submodule", "deinit", "--quiet", "--force", "--", "CoodEdit/xml_DB"); // no local copy
    fs.rmSync(lib, { recursive: true, force: true }); // and the server is unreachable
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
