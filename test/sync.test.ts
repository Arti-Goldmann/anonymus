import { afterEach, describe, expect, it } from "vitest";
import { scan } from "../src/core/scanner.js";
import { applyReconcile, planReconcile, summarize } from "../src/core/reconcile.js";
import { Syncer, type SyncEvent } from "../src/core/syncer.js";
import { makeBench, type Bench } from "./helpers.js";

/** Poll until `check` passes or time runs out. */
async function waitFor(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timeout waiting for condition");
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("startup scan and reconcile", () => {
  let bench: Bench;
  afterEach(() => bench?.cleanup());

  it("fills an empty sandbox, respecting exclude rules", async () => {
    bench = makeBench();
    bench.write("project", "BIGcorpProject_cpu01/main.c", "int BIGcorpProject;\n");
    bench.write("project", ".venv/lib.py", "x\n");
    bench.write("project", ".venv-ubuntu/lib.py", "x\n");
    bench.write("project", "build/out.c", "x\n");
    bench.write("project", "src/build/keep.c", "x\n");
    const e = bench.engine({ exclude: [".venv*", "/build"] });

    const result = await scan(e);
    expect(result.counts["only-project"]).toBe(2);
    expect(result.sandboxFiles).toBe(0);

    const plan = planReconcile(result, "project-wins");
    expect(summarize(plan).toSandbox).toBe(2);
    await applyReconcile(e, plan);

    expect(bench.read("sandbox", "MyProject_cpu01/main.c")).toBe("int MyProject;\n");
    expect(bench.exists("sandbox", "src/build/keep.c")).toBe(true);
    expect(bench.exists("sandbox", ".venv-ubuntu/lib.py")).toBe(false);
    expect(bench.exists("sandbox", "build/out.c")).toBe(false);
    expect((await scan(e)).clean).toBe(true);
  });

  it("smart strategy brings each side up to date and merges", async () => {
    bench = makeBench();
    bench.write("project", "a.txt", "BIGcorpProject a\n");
    bench.write("project", "b.txt", "b\n");
    bench.write("project", "c.txt", "1\n2\n3\n4\n");
    let e = bench.engine();
    await applyReconcile(e, planReconcile(await scan(e), "project-wins"));

    // Offline edits on both sides.
    bench.write("project", "a.txt", "BIGcorpProject a2\n");
    bench.write("sandbox", "b.txt", "b2\n");
    bench.write("project", "c.txt", "1p\n2\n3\n4\n");
    bench.write("sandbox", "c.txt", "1\n2\n3\n4s\n");
    bench.write("sandbox", "new.txt", "MyProject new\n");

    e = bench.engine();
    const result = await scan(e);
    expect(result.counts["project-changed"]).toBe(1);
    expect(result.counts["sandbox-changed"]).toBe(1);
    expect(result.counts["both-changed"]).toBe(1);
    expect(result.counts["only-sandbox"]).toBe(1);

    const outcome = await applyReconcile(e, planReconcile(result, "smart"));
    expect(outcome.merged).toBe(1);
    expect(outcome.held).toHaveLength(0);
    expect(bench.read("sandbox", "a.txt")).toBe("MyProject a2\n");
    expect(bench.read("project", "b.txt")).toBe("b2\n");
    expect(bench.read("project", "c.txt")).toBe("1p\n2\n3\n4s\n");
    expect(bench.read("project", "new.txt")).toBe("BIGcorpProject new\n");
  });

  it("smart strategy refills a wiped sandbox instead of deleting the project", async () => {
    bench = makeBench();
    bench.write("project", "a.txt", "a\n");
    let e = bench.engine();
    await applyReconcile(e, planReconcile(await scan(e), "project-wins"));
    bench.remove("sandbox", "a.txt");

    e = bench.engine();
    const plan = planReconcile(await scan(e), "smart");
    expect(summarize(plan).deleteProject).toBe(0);
    expect(summarize(plan).toSandbox).toBe(1);
  });

  it("first run with differing files leaves them to the user", async () => {
    bench = makeBench();
    bench.write("project", "x.txt", "one\n");
    bench.write("sandbox", "x.txt", "two\n");
    const e = bench.engine();
    const result = await scan(e);
    expect(result.counts["differs-unknown"]).toBe(1);
    const outcome = await applyReconcile(e, planReconcile(result, "smart"));
    expect(outcome.held.map((h) => h.canonical)).toEqual(["x.txt"]);
  });
});

describe("live Syncer", () => {
  let bench: Bench;
  let syncer: Syncer | null = null;
  afterEach(async () => {
    await syncer?.stop();
    syncer = null;
    bench?.cleanup();
  });

  async function startLive(): Promise<{ events: SyncEvent[] }> {
    const e = bench.engine();
    await applyReconcile(e, planReconcile(await scan(e), "project-wins"));
    const events: SyncEvent[] = [];
    syncer = new Syncer(e);
    syncer.on("event", (ev) => events.push(ev));
    await syncer.start();
    await sleep(300);
    return { events };
  }

  it("propagates edits both ways without echo", async () => {
    bench = makeBench();
    bench.write("project", "BIGcorpProject/a.c", "int BIGcorpProject = 1;\n");
    const { events } = await startLive();

    bench.write("sandbox", "MyProject/a.c", "int MyProject = 2;\n");
    await waitFor(() => bench.read("project", "BIGcorpProject/a.c") === "int BIGcorpProject = 2;\n");

    bench.write("project", "BIGcorpProject/a.c", "int BIGcorpProject = 3;\n");
    await waitFor(() => bench.read("sandbox", "MyProject/a.c") === "int MyProject = 3;\n");

    await sleep(800);
    const transfers = events.filter((e) => e.kind === "to-project" || e.kind === "to-sandbox");
    expect(transfers).toHaveLength(2);
  });

  it("creates new files with mapped paths and propagates deletions to trash", async () => {
    bench = makeBench();
    bench.write("project", "keep.txt", "k\n");
    await startLive();

    bench.write("sandbox", "MyProject_cpu01/new.c", "// MyProject\n");
    await waitFor(() => bench.read("project", "BIGcorpProject_cpu01/new.c") === "// BIGcorpProject\n");

    bench.remove("sandbox", "MyProject_cpu01/new.c");
    await waitFor(() => !bench.exists("project", "BIGcorpProject_cpu01/new.c"));
  });

  it("holds a conflicting file and resolves it by choice", async () => {
    bench = makeBench();
    bench.write("project", "c.txt", "line\n");
    await startLive();
    await syncer!.stop();

    // Same line edited on both sides while the tool was "busy".
    bench.write("project", "c.txt", "project line\n");
    bench.write("sandbox", "c.txt", "sandbox line\n");
    syncer = new Syncer(bench.engine());
    await syncer.start();
    await waitFor(() => syncer!.getHeld().length === 1);
    expect(bench.read("project", "c.txt")).toBe("project line\n");

    const r = await syncer.resolve("c.txt", "sandbox");
    expect(r.ok).toBe(true);
    expect(bench.read("project", "c.txt")).toBe("sandbox line\n");
    expect(syncer.getHeld()).toHaveLength(0);
  });
});
