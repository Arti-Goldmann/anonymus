import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import iconv from "iconv-lite";
import { defaultMergeSources, prepareMerge } from "../src/core/mergePrep.js";
import { applyReconcile, planReconcile } from "../src/core/reconcile.js";
import { scan } from "../src/core/scanner.js";
import { Workspace } from "../src/core/workspace.js";
import { makeBench, type Bench } from "./helpers.js";

/** A file where the agents change lines far apart (no overlapping context). */
const BODY = (a: number, c: number, name: string) =>
  `int a = ${a};\n${"int pad = 0;\n".repeat(8)}int c = ${c};\n// ${name}\n`;

describe("merging the work of several agents", () => {
  let bench: Bench;
  afterEach(() => bench?.cleanup());

  /** Project on master, `result_merge` created from it and active. */
  async function setup(): Promise<Workspace> {
    bench = makeBench();
    bench.write("project", "BIGcorpProject/main.c", BODY(1, 3, "BIGcorpProject"));
    bench.writeWin1251("project", "BIGcorpProject/ru.c", "// Комментарий BIGcorpProject\r\nint x;\r\n");
    bench.write("project", "docs/old.md", "obsolete\n");
    bench.gitInit();
    const ws = new Workspace(bench.config());
    ws.reconcileWithGit();
    ws.create("result_merge");
    const engine = ws.engineFor();
    await applyReconcile(engine, planReconcile(await scan(engine), "project-wins"));
    return ws;
  }

  const folder = (ws: Workspace, name: string) => ws.registry.absPath(ws.registry.get(name)!);

  it("creates agent branches off a chosen branch without switching, filled from git", async () => {
    const ws = await setup();
    const { entry, filled } = ws.create("agent-a", { from: "result_merge", switchTo: false });

    expect(bench.git("branch", "--show-current")).toBe("result_merge"); // project untouched
    expect(bench.git("rev-parse", "agent-a")).toBe(bench.git("rev-parse", "result_merge"));
    expect(entry.base).toEqual({ branch: "result_merge", commit: bench.git("rev-parse", "result_merge") });
    expect(filled).toBe(3);
    const dir = folder(ws, "agent-a");
    expect(fs.readFileSync(path.join(dir, "MyProject", "main.c"), "utf8")).toContain("// MyProject");
    // win1251 stays win1251 in the sub-sandbox.
    expect(iconv.decode(fs.readFileSync(path.join(dir, "MyProject", "ru.c")), "win1251")).toBe(
      "// Комментарий MyProject\r\nint x;\r\n"
    );

    // When it becomes active, both sides are already equal.
    ws.switchTo("agent-a");
    const result = await scan(ws.engineFor());
    expect(result.clean).toBe(true);
  });

  it("builds anonymized patches of unsynced agent work that apply to the base", async () => {
    const ws = await setup();
    ws.create("agent-a", { from: "result_merge", switchTo: false });
    ws.create("agent-b", { from: "result_merge", switchTo: false });
    ws.create("other", { from: "master", switchTo: false });

    // Agents work in their folders; nothing is synced to git.
    const a = folder(ws, "agent-a");
    fs.writeFileSync(path.join(a, "MyProject", "main.c"), BODY(10, 3, "MyProject"));
    fs.writeFileSync(path.join(a, "MyProject", "new.c"), "// new from agent A in MyProject\n");
    // A Windows-1251 + CRLF file with Cyrillic context: the patch must apply as is.
    fs.writeFileSync(
      path.join(a, "MyProject", "ru.c"),
      iconv.encode("// Комментарий MyProject (агент A)\r\nint x = 1;\r\n", "win1251")
    );
    const b = folder(ws, "agent-b");
    fs.writeFileSync(path.join(b, "MyProject", "main.c"), BODY(1, 30, "MyProject"));
    fs.rmSync(path.join(b, "docs", "old.md"));

    expect(defaultMergeSources(ws, "result_merge").sort()).toEqual(["agent-a", "agent-b"]);
    const { dir, sources } = prepareMerge(ws, "result_merge", ["agent-a", "agent-b"]);

    expect(dir).toBe(path.join(folder(ws, "result_merge"), ".anonymus-merge"));
    const byName = Object.fromEntries(sources.map((s) => [s.name, s]));
    expect(byName["agent-a"]).toMatchObject({ modified: 2, added: 1, deleted: 0, leaks: [] });
    expect(byName["agent-b"]).toMatchObject({ modified: 1, added: 0, deleted: 1, leaks: [] });

    const patchA = fs.readFileSync(path.join(dir, "agent-a.patch"), "utf8");
    expect(patchA).toContain("+int a = 10;");
    expect(patchA).toContain("+++ b/MyProject/new.c");
    expect(patchA).not.toMatch(/BIGcorp/i);
    expect(fs.readFileSync(path.join(dir, "index.txt"), "utf8")).toContain("agent-b.patch");
    expect(ws.registry.get("result_merge")!.mergeSources).toEqual(["agent-a", "agent-b"]);

    // Both patches apply cleanly, in turn, to a copy of the base (as the agent would).
    const work = path.join(bench.root, "apply-check");
    fs.cpSync(folder(ws, "result_merge"), work, { recursive: true });
    fs.rmSync(path.join(work, ".anonymus-merge"), { recursive: true });
    execFileSync("git", ["init", "--quiet"], { cwd: work });
    for (const p of ["agent-a.patch", "agent-b.patch"]) {
      execFileSync("git", ["apply", "--whitespace=nowarn", path.join(dir, p)], { cwd: work });
    }
    expect(fs.readFileSync(path.join(work, "MyProject", "main.c"), "utf8")).toBe(
      BODY(10, 30, "MyProject")
    );
    expect(fs.existsSync(path.join(work, "MyProject", "new.c"))).toBe(true);
    expect(fs.existsSync(path.join(work, "docs", "old.md"))).toBe(false);
    // The Windows-1251 + CRLF file got the change without any conversion.
    const ru = fs.readFileSync(path.join(work, "MyProject", "ru.c"));
    expect(iconv.decode(ru, "win1251")).toBe("// Комментарий MyProject (агент A)\r\nint x = 1;\r\n");
  });

  it("never syncs the merge folder into the project", async () => {
    const ws = await setup();
    ws.create("agent-a", { from: "result_merge", switchTo: false });
    fs.writeFileSync(path.join(folder(ws, "agent-a"), "MyProject", "main.c"), "changed\n");
    prepareMerge(ws, "result_merge", ["agent-a"]);
    const result = await scan(ws.engineFor());
    expect(result.statuses.some((s) => s.canonical.startsWith(".anonymus-merge"))).toBe(false);
    expect(bench.exists("project", ".anonymus-merge/agent-a.patch")).toBe(false);
  });

  it("commits the merged result with a default message, without anonymus files", async () => {
    const ws = await setup();
    ws.create("agent-a", { from: "result_merge", switchTo: false });
    prepareMerge(ws, "result_merge", ["agent-a"]);
    bench.write("project", "BIGcorpProject/main.c", "merged\n");

    expect(ws.defaultCommitMessage()).toBe("Слияние: agent-a");
    expect(ws.commitActive()).toBe(true);
    expect(bench.git("log", "-1", "--format=%s")).toBe("Слияние: agent-a");
    expect(bench.git("show", "--name-only", "--format=", "HEAD")).toBe("BIGcorpProject/main.c");
    expect(ws.commitActive()).toBe(false); // nothing left
    expect(ws.defaultCommitMessage()).toBe("Изменения подпесочницы result_merge");
  });
});
