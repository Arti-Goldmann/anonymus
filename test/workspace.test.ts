import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyReconcile, planReconcile } from "../src/core/reconcile.js";
import { scan } from "../src/core/scanner.js";
import { Workspace } from "../src/core/workspace.js";
import { acquireLock } from "../src/core/lock.js";
import { makeBench, type Bench } from "./helpers.js";

/** Fill the active sub-sandbox from the project (what the UI does on an empty sandbox). */
async function fill(ws: Workspace): Promise<void> {
  const engine = ws.engineFor();
  await applyReconcile(engine, planReconcile(await scan(engine), "project-wins"));
}

describe("Workspace: sub-sandboxes per branch", () => {
  let bench: Bench;
  afterEach(() => bench?.cleanup());

  function setup(): Workspace {
    bench = makeBench();
    bench.write("project", "BIGcorpProject/main.c", "int v = 1; // BIGcorpProject\n");
    bench.write("project", "anonymus.yaml", "# config with real names, not in .gitignore on purpose\n");
    bench.gitInit();
    const ws = new Workspace(bench.config());
    ws.reconcileWithGit();
    return ws;
  }

  it("seeds the registry from `sandbox:` with the current branch", () => {
    const ws = setup();
    expect(ws.gitEnabled).toBe(true);
    expect(ws.registry.list().map((s) => [s.name, s.branch])).toEqual([["default", "master"]]);
    expect(ws.registry.absPath(ws.active)).toBe(bench.sandbox);
    expect(fs.existsSync(path.join(bench.project, ".anonymus", "sandboxes.json"))).toBe(true);
  });

  it("creates a branch from HEAD and an anonymized folder, then switches to it", async () => {
    const ws = setup();
    await fill(ws);
    const { entry } = ws.create("BIGcorpProject-uart");

    expect(bench.git("branch", "--show-current")).toBe("BIGcorpProject-uart");
    expect(entry.branch).toBe("BIGcorpProject-uart");
    // The folder the agent sees carries the placeholder, not the real name.
    expect(path.basename(ws.registry.absPath(entry))).toBe("MyProject-uart");
    expect(ws.active.name).toBe("BIGcorpProject-uart");

    await fill(ws);
    expect(fs.readFileSync(path.join(ws.registry.absPath(entry), "MyProject", "main.c"), "utf8")).toBe(
      "int v = 1; // MyProject\n"
    );
  });

  it("rejects bad or duplicate names", () => {
    const ws = setup();
    expect(ws.validateNewName("bad name with ..")).toMatch(/не подходит/);
    expect(ws.validateNewName("master")).toMatch(/уже существует/);
    expect(ws.validateNewName("ok-name")).toBeNull();
  });

  it("stashes uncommitted work per branch and brings it back on return", async () => {
    const ws = setup();
    await fill(ws);
    ws.create("feature");
    await fill(ws);

    // Work on `feature` (as synced from its sub-sandbox), uncommitted.
    bench.write("project", "BIGcorpProject/main.c", "int v = 2; // BIGcorpProject\n");
    bench.write("project", "BIGcorpProject/new.c", "// new on feature\n");

    ws.switchTo("default");
    expect(bench.git("branch", "--show-current")).toBe("master");
    expect(bench.read("project", "BIGcorpProject/main.c")).toBe("int v = 1; // BIGcorpProject\n");
    expect(bench.exists("project", "BIGcorpProject/new.c")).toBe(false);
    expect(ws.registry.get("feature")!.stash).toMatch(/^anonymus:feature:/);
    // anonymus' own files never travel with the stash.
    expect(bench.exists("project", "anonymus.yaml")).toBe(true);
    expect(bench.exists("project", ".anonymus/sandboxes.json")).toBe(true);

    const warnings = ws.switchTo("feature");
    expect(warnings).toEqual([]);
    expect(bench.git("branch", "--show-current")).toBe("feature");
    expect(bench.read("project", "BIGcorpProject/main.c")).toBe("int v = 2; // BIGcorpProject\n");
    expect(bench.read("project", "BIGcorpProject/new.c")).toBe("// new on feature\n");
    expect(ws.registry.get("feature")!.stash).toBeNull();
  });

  it("switches when anonymus' own files are in .gitignore (as `anonymus init` sets it up)", async () => {
    bench = makeBench();
    bench.write("project", "BIGcorpProject/main.c", "int v = 1;\n");
    bench.write("project", ".gitignore", "anonymus.yaml\n.anonymus/\n");
    bench.write("project", "anonymus.yaml", "# real names\n");
    bench.gitInit();
    const ws = new Workspace(bench.config());
    ws.reconcileWithGit();
    ws.create("feature");
    bench.write("project", "BIGcorpProject/main.c", "int v = 2;\n");
    bench.write("project", "BIGcorpProject/new.c", "// new\n");

    ws.switchTo("default");
    expect(bench.git("branch", "--show-current")).toBe("master");
    expect(bench.read("project", "BIGcorpProject/main.c")).toBe("int v = 1;\n");
    expect(bench.exists("project", "anonymus.yaml")).toBe(true);
    expect(bench.git("stash", "list").split("\n").filter(Boolean)).toHaveLength(1);

    ws.switchTo("feature");
    expect(bench.read("project", "BIGcorpProject/main.c")).toBe("int v = 2;\n");
    expect(bench.read("project", "BIGcorpProject/new.c")).toBe("// new\n");
    expect(bench.git("stash", "list")).toBe("");

    // Committing also works with ignored own files.
    expect(ws.commitActive("feature work")).toBe(true);
    expect(bench.git("show", "--name-only", "--format=", "HEAD").split("\n").sort()).toEqual([
      "BIGcorpProject/main.c",
      "BIGcorpProject/new.c",
    ]);
  });

  it("picks the sub-sandbox of a branch that was checked out by hand", () => {
    const ws = setup();
    ws.create("feature");
    bench.git("checkout", "--quiet", "master");
    const again = new Workspace(bench.config());
    const notices = again.reconcileWithGit();
    expect(again.active.name).toBe("default");
    expect(notices[0].message).toMatch(/ветка master/);
    expect(again.branchMismatch).toBe(false);
  });

  it("removes a sub-sandbox to the trash and keeps the branch", async () => {
    const ws = setup();
    ws.create("feature");
    await fill(ws);
    const folder = ws.registry.absPath(ws.registry.get("feature")!);
    expect(() => ws.remove("feature")).toThrow(/активную/);

    ws.switchTo("default");
    const { trashDir } = ws.remove("feature");
    expect(fs.existsSync(folder)).toBe(false);
    expect(fs.existsSync(path.join(trashDir, path.basename(folder), "MyProject", "main.c"))).toBe(true);
    expect(ws.registry.get("feature")).toBeUndefined();
    expect(bench.git("branch", "--list", "feature")).toContain("feature");
  });

  it("removes a sub-sandbox together with its branch's stash, or keeps the stash on request", () => {
    const ws = setup();
    ws.create("keep");
    bench.write("project", "BIGcorpProject/main.c", "int v = 2; // keep\n");
    ws.create("drop"); // switching away from `keep` stashes its work
    bench.write("project", "BIGcorpProject/main.c", "int v = 3; // drop\n");
    ws.switchTo("default"); // ...and `drop`'s work too
    expect(ws.hasStash("keep")).toBe(true);
    expect(ws.hasStash("drop")).toBe(true);
    expect(bench.git("stash", "list").split("\n")).toHaveLength(2);

    const kept = ws.remove("keep");
    expect(kept.stashDropped).toBe(false);
    expect(kept.warnings[0]).toMatch(/остался stash/);

    const dropped = ws.remove("drop", () => {}, { dropStash: true });
    expect(dropped.stashDropped).toBe(true);
    expect(dropped.warnings).toEqual([]);

    const remaining = bench.git("stash", "list");
    expect(remaining).toContain("anonymus:keep:");
    expect(remaining).not.toContain("anonymus:drop:");
    expect(bench.git("branch", "--list", "drop")).toContain("drop"); // the branch itself stays
  });

  it("allows only one running instance per project, whatever the profile", () => {
    bench = makeBench();
    const dir = path.join(bench.project, ".anonymus");
    const first = acquireLock(dir);
    expect("release" in first).toBe(true);
    // Simulate another live process holding the lock.
    fs.writeFileSync(path.join(dir, "lock"), String(process.ppid));
    expect(acquireLock(dir)).toEqual({ heldBy: process.ppid });
  });
});

describe("Workspace without git", () => {
  let bench: Bench;
  afterEach(() => bench?.cleanup());

  it("keeps working with the single default sandbox", () => {
    bench = makeBench();
    const ws = new Workspace(bench.config());
    ws.reconcileWithGit();
    expect(ws.gitEnabled).toBe(false);
    expect(ws.active.name).toBe("default");
    expect(ws.validateNewName("x")).toMatch(/не является git/);
  });
});
