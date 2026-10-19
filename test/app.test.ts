import * as fs from "node:fs";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import { afterEach, describe, expect, it } from "vitest";
import { Workspace } from "../src/core/workspace.js";
import { App } from "../src/ui/App.js";
import { makeBench, type Bench } from "./helpers.js";

class FakeStdout extends EventEmitter {
  columns = 110;
  rows = 40;
  isTTY = true;
  frames: string[] = [];
  write(s: string) {
    this.frames.push(s);
    return true;
  }
  /** Last frame as plain text. */
  get screen(): string {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const plain = this.frames[i].replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
      if (plain.trim().length > 20) return plain;
    }
    return "";
  }
}

async function until(check: () => boolean, what: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for: ${what}
${(globalThis as { __screen?: () => string }).__screen?.() ?? ""}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const MASCOT_ROW = /▀{20,}/; // a full mascot row is a long run of half blocks

describe("App: pairs of sub-sandbox ⇄ worktree", () => {
  let bench: Bench;
  let unmount: (() => void) | null = null;
  afterEach(async () => {
    unmount?.();
    unmount = null;
    await new Promise((r) => setTimeout(r, 300)); // let watchers close
    bench?.cleanup();
  });

  function startApp(ws: Workspace) {
    const out = new FakeStdout();
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
    const app = render(React.createElement(App, { workspace: ws, version: "test", warnings: [] }), {
      stdout: out as never,
      stdin: stdin as never,
      patchConsole: false,
      exitOnCtrlC: false,
    });
    unmount = () => app.unmount();
    (globalThis as { __screen?: () => string }).__screen = () => out.screen;
    return { out, press: (keys: string) => stdin.write(keys) };
  }

  it("creates a pair, syncs it, stops it when its worktree is removed and recovers it", async () => {
    bench = makeBench();
    bench.write("project", "BIGcorpProject/main.c", "int v = 1; // BIGcorpProject\n");
    bench.write("project", ".gitignore", "anonymus.yaml\n.anonymus/\n");
    bench.gitInit();
    const ws = new Workspace(bench.config());
    const { out, press } = startApp(ws);

    await until(() => out.screen.includes("Подпесочниц пока нет"), "empty list");
    expect(out.screen).toMatch(MASCOT_ROW);

    // n → name → Enter: branch + worktree + sandbox, filled and synced right away.
    press("n");
    await until(() => out.screen.includes("Имя новой подпесочницы"), "name input");
    press("feature-x");
    await until(() => /sandboxes[\\/]feature-x/.test(out.screen), "preview of the folders");
    press("\r");
    await until(() => out.screen.includes("feature-x") && out.screen.includes("синхронно"), "pair live");
    const entry = ws.pair("feature-x");
    const sandboxMain = path.join(entry.sandboxDir, "MyProject", "main.c");
    expect(fs.readFileSync(sandboxMain, "utf8")).toBe("int v = 1; // MyProject\n");
    expect(bench.git("branch", "--show-current")).toBe("master"); // the main folder is never touched

    // An agent edit reaches the worktree; the first transfer folds the mascot.
    fs.writeFileSync(sandboxMain, "int v = 2; // MyProject\n");
    const worktreeMain = path.join(entry.projectDir, "BIGcorpProject", "main.c");
    await until(() => fs.readFileSync(worktreeMain, "utf8") === "int v = 2; // BIGcorpProject\n", "sync to worktree");
    await until(() => !MASCOT_ROW.test(out.screen), "mascot folded");

    // The worktree is removed with git behind anonymus' back: the pair stops, the sandbox is intact.
    bench.git("worktree", "remove", "--force", entry.projectDir);
    await until(() => out.screen.includes("остановлена: worktree удалён"), "pair stopped");
    await new Promise((r) => setTimeout(r, 500));
    expect(fs.readFileSync(sandboxMain, "utf8")).toBe("int v = 2; // MyProject\n");

    // Enter → problem screen → w → y: worktree re-created, review recommends sandbox → project.
    press("\r");
    await until(() => out.screen.includes("«feature-x» остановлена"), "problem screen");
    press("w");
    await until(() => out.screen.includes("Создать worktree заново"), "confirm recreate");
    press("y");
    await until(() => out.screen.includes("создан заново"), "review with a note");
    expect(out.screen).toMatch(/Песочница → проект \(рекомендуется\)/);
    press("\r");
    await until(() => out.screen.includes("что будет сделано"), "plan");
    press("\r");
    await until(() => out.screen.includes("синхронно"), "live again");
    expect(fs.readFileSync(worktreeMain, "utf8")).toBe("int v = 2; // BIGcorpProject\n");
  }, 60000);
});
