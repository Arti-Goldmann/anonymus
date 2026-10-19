import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyReconcile, planReconcile } from "../src/core/reconcile.js";
import { scan } from "../src/core/scanner.js";
import type { Syncer } from "../src/core/syncer.js";
import { Workspace } from "../src/core/workspace.js";
import { makeBench, type Bench } from "./helpers.js";
import { livePair, sleep, waitFor } from "./pairs.js";

/**
 * The one thing that must never happen: a sandbox syncing with a folder that
 * is not its own worktree. Every scenario starts a live pair and then breaks
 * the worktree (or the sandbox) from outside, the way a user might.
 */
describe("pair guard: a sandbox only ever syncs with its own worktree", () => {
  let bench: Bench;
  let syncer: Syncer | null = null;
  afterEach(async () => {
    await syncer?.stop();
    syncer = null;
    bench?.cleanup();
  });

  const FILES = 8;

  async function setup() {
    bench = makeBench();
    for (let i = 0; i < FILES; i++) {
      bench.write("project", `BIGcorpProject/f${i}.c`, `int f${i}; // BIGcorpProject\n`);
    }
    bench.write("project", ".gitignore", "anonymus.yaml\n.anonymus/\n");
    bench.gitInit();
    bench.git("branch", "other");
    const ws = new Workspace(bench.config());
    const entry = ws.create("feature");
    const live = await livePair(ws, "feature");
    syncer = live.syncer;
    // Uncommitted agent work that only lives in the pair so far.
    fs.writeFileSync(path.join(entry.sandbox, "MyProject", "f0.c"), "int f0 = 42; // MyProject\n");
    await waitFor(() => fs.readFileSync(path.join(entry.worktree, "BIGcorpProject", "f0.c"), "utf8").includes("42"));
    return { ws, entry };
  }

  function sandboxFiles(dir: string): string[] {
    return fs.existsSync(path.join(dir, "MyProject")) ? fs.readdirSync(path.join(dir, "MyProject")).sort() : [];
  }

  it("git worktree remove: the pair stops, nothing is deleted in the sandbox", async () => {
    const { entry } = await setup();
    bench.git("worktree", "remove", "--force", entry.worktree);
    await waitFor(() => syncer!.getProblem() !== null);
    expect(syncer!.getProblem()!.code).toBe("worktree-missing");
    await sleep(800);
    expect(sandboxFiles(entry.sandbox)).toHaveLength(FILES);
    expect(fs.readFileSync(path.join(entry.sandbox, "MyProject", "f0.c"), "utf8")).toContain("42");
  });

  it("worktree folder deleted by hand (no prune): the same", async () => {
    const { entry } = await setup();
    fs.rmSync(entry.worktree, { recursive: true, force: true });
    await waitFor(() => syncer!.getProblem() !== null);
    await sleep(800);
    expect(sandboxFiles(entry.sandbox)).toHaveLength(FILES);
  });

  it("worktree removed and created again by git at the same path: not ours, never synced", async () => {
    const { ws, entry } = await setup();
    bench.git("worktree", "remove", "--force", entry.worktree);
    await waitFor(() => syncer!.getProblem() !== null);
    await syncer!.stop();
    syncer = null;

    // Same branch: the content is the committed one, the agent's work is not there.
    bench.git("worktree", "add", entry.worktree, "feature");
    expect(ws.check("feature", true)?.code).toBe("foreign-worktree");
    // Another branch at the same path.
    bench.git("worktree", "remove", "--force", entry.worktree);
    bench.git("worktree", "add", entry.worktree, "other");
    expect(ws.check("feature", true)?.code).toBe("foreign-worktree");
    // The sandbox keeps the agent's work.
    expect(fs.readFileSync(path.join(entry.sandbox, "MyProject", "f0.c"), "utf8")).toContain("42");
  });

  it("a plain folder or a separate clone at the worktree path is refused", async () => {
    const { ws, entry } = await setup();
    await syncer!.stop();
    syncer = null;
    bench.git("worktree", "remove", "--force", entry.worktree);
    fs.mkdirSync(path.join(entry.worktree, "BIGcorpProject"), { recursive: true });
    expect(ws.check("feature", true)?.code).toBe("not-worktree");
    fs.mkdirSync(path.join(entry.worktree, ".git"));
    expect(ws.check("feature", true)?.message).toMatch(/отдельный git-репозиторий/);
  });

  it("git checkout inside the worktree: stops before the other branch reaches the sandbox", async () => {
    const { entry } = await setup();
    bench.gitIn(entry.worktree, "commit", "--quiet", "-am", "wip"); // no file changes, just history
    bench.gitIn(entry.worktree, "checkout", "--quiet", "other");
    await waitFor(() => syncer!.getProblem() !== null);
    expect(syncer!.getProblem()).toMatchObject({ code: "wrong-branch", actualBranch: "other" });
    await sleep(800);
    expect(fs.readFileSync(path.join(entry.sandbox, "MyProject", "f0.c"), "utf8")).toContain("42");
  });

  it("sandbox folder deleted: nothing is deleted in the worktree", async () => {
    const { entry } = await setup();
    fs.rmSync(entry.sandbox, { recursive: true, force: true });
    await waitFor(() => syncer!.getProblem() !== null);
    expect(syncer!.getProblem()!.code).toBe("sandbox-missing");
    await sleep(800);
    expect(fs.readdirSync(path.join(entry.worktree, "BIGcorpProject"))).toHaveLength(FILES);
  });

  it("a wave of deletions stops before it spreads", async () => {
    const { entry } = await setup();
    // Sandbox folder stays, but most files vanish at once.
    for (let i = 1; i < FILES; i++) {
      fs.rmSync(path.join(entry.sandbox, "MyProject", `f${i}.c`));
    }
    await waitFor(() => syncer!.getProblem() !== null);
    expect(syncer!.getProblem()).toMatchObject({ code: "mass-delete", side: "sandbox" });
    await sleep(500);
    // At most the allowed few went through; the rest are intact in the worktree.
    const left = fs.readdirSync(path.join(entry.worktree, "BIGcorpProject")).length;
    expect(left).toBeGreaterThanOrEqual(FILES - 5);
  });

  it("two pairs pointing at one worktree are refused at start-up", async () => {
    const { ws } = await setup();
    await syncer!.stop();
    syncer = null;
    ws.create("second");
    const file = path.join(bench.project, ".anonymus", "sandboxes.json");
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    data.sandboxes[1].worktree = data.sandboxes[0].worktree;
    fs.writeFileSync(file, JSON.stringify(data));
    expect(new Workspace(bench.config()).problems().join("\n")).toMatch(/общий worktree/);
  });

  it("re-creating a lost worktree needs a review: sandbox → project brings the agent's work back", async () => {
    const { ws, entry } = await setup();
    bench.git("worktree", "remove", "--force", entry.worktree);
    await waitFor(() => syncer!.getProblem() !== null);
    await syncer!.stop();
    syncer = null;

    ws.recreateWorktree("feature");
    expect(ws.check("feature", true)).toBeNull();
    expect(ws.pair("feature").entry!.needsReview).toBe(true);
    // The worktree has the committed text, the sandbox the agent's work; the
    // old history is gone, so nothing would be overwritten automatically.
    const engine = ws.engineFor("feature");
    expect(engine.state.size).toBe(0);
    const result = await scan(engine);
    expect(result.statuses.find((s) => s.canonical === "BIGcorpProject/f0.c")?.kind).toBe("differs-unknown");

    await applyReconcile(engine, planReconcile(result, "sandbox-wins"));
    expect(fs.readFileSync(path.join(entry.worktree, "BIGcorpProject", "f0.c"), "utf8")).toBe("int f0 = 42; // BIGcorpProject\n");
  });

  it("follows a worktree moved with git worktree move", async () => {
    const { ws, entry } = await setup();
    await syncer!.stop();
    syncer = null;
    const moved = path.join(bench.root, "moved-feature");
    bench.git("worktree", "move", entry.worktree, moved);
    expect(ws.check("feature", true)?.code).toBe("worktree-missing");
    expect(ws.movedTo("feature")).toBe(moved);
    ws.relocate("feature");
    expect(ws.check("feature", true)).toBeNull();
  });
});
