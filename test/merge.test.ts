import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import iconv from "iconv-lite";
import { abortMerge, continueMerge, startMerge } from "../src/core/gitMerge.js";
import { defaultMergeSources } from "../src/core/mergePrep.js";
import type { Syncer } from "../src/core/syncer.js";
import { Workspace } from "../src/core/workspace.js";
import { makeBench, type Bench } from "./helpers.js";
import { livePair, waitFor } from "./pairs.js";

/** A file where agents can change lines far apart (no overlapping context). */
const BODY = (a: number, c: number, name: string) =>
  `int a = ${a};\n${"int pad = 0;\n".repeat(8)}int c = ${c};\n// ${name}\n`;

describe("merging the work of several agents with git merge", () => {
  let bench: Bench;
  const syncers = new Map<string, Syncer>();
  afterEach(async () => {
    await Promise.all([...syncers.values()].map((s) => s.stop()));
    syncers.clear();
    bench?.cleanup();
  });

  /** master → result-merge → agent-a/b/c, all pairs syncing. */
  async function setup(): Promise<Workspace> {
    bench = makeBench();
    bench.write("project", "BIGcorpProject/main.c", BODY(1, 3, "BIGcorpProject"));
    bench.writeWin1251("project", "BIGcorpProject/ru.c", "// Комментарий BIGcorpProject\r\nint x;\r\n");
    bench.write("project", "docs/old.md", "obsolete\n");
    bench.write("project", ".gitignore", "anonymus.yaml\n.anonymus/\n");
    bench.gitInit();
    const ws = new Workspace(bench.config());
    ws.create("result-merge", { from: "master" });
    for (const name of ["agent-a", "agent-b", "agent-c"]) {
      ws.create(name, { from: "result-merge" });
    }
    for (const p of ws.pairs()) {
      syncers.set(p.name, (await livePair(ws, p.name)).syncer);
    }
    return ws;
  }

  const sandbox = (ws: Workspace, name: string, rel: string) => path.join(ws.pair(name).sandboxDir, ...rel.split("/"));
  const worktree = (ws: Workspace, name: string, rel: string) => path.join(ws.pair(name).projectDir, ...rel.split("/"));
  const read = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null);

  /** What the UI checks before merging: synced, nothing waiting. */
  const settled = (name: string): string | null => {
    const s = syncers.get(name);
    if (!s || s.getProblem()) return "не синхронизируется";
    if (s.getHeld().length) return "есть файлы на решение";
    return s.isIdle() ? null : "ещё синхронизируется";
  };
  const allSettled = () => [...syncers.keys()].every((n) => settled(n) === null);

  /** Agents work in their sandboxes; the work reaches their worktrees. */
  async function agentsWork(ws: Workspace, conflict: boolean): Promise<void> {
    fs.writeFileSync(sandbox(ws, "agent-a", "MyProject/main.c"), BODY(10, 3, "MyProject"));
    fs.writeFileSync(sandbox(ws, "agent-a", "MyProject/new.c"), "// new from agent A in MyProject\n");
    fs.writeFileSync(sandbox(ws, "agent-b", "MyProject/main.c"), BODY(1, 30, "MyProject"));
    fs.writeFileSync(
      sandbox(ws, "agent-b", "MyProject/ru.c"),
      iconv.encode("// Комментарий MyProject (агент B)\r\nint x = 1;\r\n", "win1251")
    );
    fs.rmSync(sandbox(ws, "agent-b", "docs/old.md"));
    if (conflict) {
      fs.writeFileSync(sandbox(ws, "agent-c", "MyProject/main.c"), BODY(99, 3, "MyProject"));
    }
    await waitFor(() => read(worktree(ws, "agent-a", "BIGcorpProject/new.c")) !== null);
    await waitFor(() => !fs.existsSync(worktree(ws, "agent-b", "docs/old.md")));
    if (conflict) {
      await waitFor(() => read(worktree(ws, "agent-c", "BIGcorpProject/main.c"))?.includes("a = 99") ?? false);
    }
    await waitFor(allSettled);
  }

  it("commits each agent's work and merges it with git; the result syncs into the target sandbox", async () => {
    const ws = await setup();
    await agentsWork(ws, false);
    expect(defaultMergeSources(ws, "result-merge").sort()).toEqual(["agent-a", "agent-b", "agent-c"]);

    const outcome = startMerge(ws, "result-merge", ["agent-a", "agent-b", "agent-c"], settled);
    expect(outcome).toMatchObject({ stoppedAt: null, merged: ["agent-a", "agent-b", "agent-c"] });
    expect(ws.pair("result-merge").entry!.merge).toBeNull();

    // The agents' work became commits on their branches, merged with --no-ff.
    expect(bench.git("log", "-1", "--format=%s", "agent-a")).toBe("anonymus: работа agent-a");
    const subjects = bench.git("log", "--format=%s", "result-merge").split("\n");
    expect(subjects.filter((s) => s.startsWith("Слияние agent-"))).toHaveLength(2); // agent-c had nothing new

    // Live sync brings the merge into the target sandbox, encodings kept.
    await waitFor(() => read(sandbox(ws, "result-merge", "MyProject/main.c")) === BODY(10, 30, "MyProject"));
    await waitFor(() => fs.existsSync(sandbox(ws, "result-merge", "MyProject/new.c")));
    await waitFor(() => !fs.existsSync(sandbox(ws, "result-merge", "docs/old.md")));
    await waitFor(() =>
      iconv.decode(fs.readFileSync(sandbox(ws, "result-merge", "MyProject/ru.c")), "win1251").includes("агент B")
    );
    expect(iconv.decode(fs.readFileSync(sandbox(ws, "result-merge", "MyProject/ru.c")), "win1251")).toBe(
      "// Комментарий MyProject (агент B)\r\nint x = 1;\r\n"
    );
  });

  it("stops on a conflict: anonymized markers and notes for the agent, then continues", async () => {
    const ws = await setup();
    await agentsWork(ws, true);

    const outcome = startMerge(ws, "result-merge", ["agent-a", "agent-b", "agent-c"], settled);
    expect(outcome.stoppedAt).toBe("agent-c");
    expect(outcome.merged).toEqual(["agent-a", "agent-b"]);
    expect(outcome.conflicts).toEqual(["BIGcorpProject/main.c"]);
    expect(outcome.leaks).toEqual([]);
    expect(ws.pair("result-merge").entry!.merge).toMatchObject({ current: "agent-c", done: ["agent-a", "agent-b"] });

    // The markers reach the agent with placeholders only.
    const target = sandbox(ws, "result-merge", "MyProject/main.c");
    await waitFor(() => read(target)?.includes("<<<<<<<") ?? false);
    expect(read(target)).toContain(">>>>>>> agent-c");
    expect(read(target)).not.toMatch(/BIGcorp/i);
    const notes = path.join(ws.pair("result-merge").sandboxDir, ".anonymus-merge");
    expect(fs.readFileSync(path.join(notes, "CONFLICTS.txt"), "utf8")).toContain("MyProject/main.c");
    expect(fs.readFileSync(path.join(notes, "agent-c.patch"), "utf8")).toContain("+int a = 99;");
    expect(fs.readFileSync(path.join(notes, "agent-c.patch"), "utf8")).not.toMatch(/BIGcorp/i);
    // The notes never travel to the project.
    expect(fs.existsSync(worktree(ws, "result-merge", ".anonymus-merge"))).toBe(false);

    // Markers left: continuing is refused.
    await waitFor(() => settled("result-merge") === null);
    expect(() => continueMerge(ws, "result-merge", settled)).toThrow(/маркеры конфликта/);

    // The agent resolves in the sandbox; sync carries it to the worktree.
    fs.writeFileSync(target, BODY(109, 30, "MyProject"));
    await waitFor(() => read(worktree(ws, "result-merge", "BIGcorpProject/main.c")) === BODY(109, 30, "BIGcorpProject"));
    await waitFor(() => settled("result-merge") === null);
    const done = continueMerge(ws, "result-merge", settled);
    expect(done.stoppedAt).toBeNull();
    expect(ws.pair("result-merge").entry!.merge).toBeNull();
    expect(fs.existsSync(notes)).toBe(false);
    expect(bench.git("log", "-1", "--format=%s", "result-merge")).toBe("Слияние agent-c в result-merge (anonymus)");
    expect(bench.gitIn(ws.pair("result-merge").projectDir, "status", "--porcelain")).toBe("");
  });

  it("aborts a merge in progress", async () => {
    const ws = await setup();
    await agentsWork(ws, true);
    startMerge(ws, "result-merge", ["agent-a", "agent-c"], settled);
    const before = bench.git("rev-parse", "result-merge");
    abortMerge(ws, "result-merge");
    expect(ws.pair("result-merge").entry!.merge).toBeNull();
    expect(bench.gitIn(ws.pair("result-merge").projectDir, "status", "--porcelain")).toBe("");
    expect(bench.git("rev-parse", "result-merge")).toBe(before); // agent-a's merge commit stays
    expect(read(worktree(ws, "result-merge", "BIGcorpProject/main.c"))).toBe(BODY(10, 3, "BIGcorpProject"));
  });

  it("refuses to start while a pair is not in sync", async () => {
    const ws = await setup();
    await syncers.get("agent-a")!.stop();
    syncers.delete("agent-a");
    expect(() => startMerge(ws, "result-merge", ["agent-a"], settled)).toThrow(/agent-a/);
    expect(ws.pair("result-merge").entry!.merge ?? null).toBeNull();
  });
});
