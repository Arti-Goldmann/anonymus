import * as fs from "node:fs";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import { afterEach, describe, expect, it } from "vitest";
import { Workspace } from "../src/core/workspace.js";
import { App } from "../src/ui/App.js";
import { mouseFilteredStdin } from "../src/ui/mouse.js";
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

const MASCOT_ROW = /▀{14,}/; // the mascot's top row is a run of half blocks

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
      stdin: mouseFilteredStdin(stdin),
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

    // An agent edit reaches the worktree; the mascot stays (only a small window hides it).
    fs.writeFileSync(sandboxMain, "int v = 2; // MyProject\n");
    const worktreeMain = path.join(entry.projectDir, "BIGcorpProject", "main.c");
    await until(() => fs.readFileSync(worktreeMain, "utf8") === "int v = 2; // BIGcorpProject\n", "sync to worktree");
    expect(out.screen).toMatch(MASCOT_ROW);

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

  it("shows the mascot while there is room and a one-line header in a small window", async () => {
    bench = makeBench();
    bench.write("project", "BIGcorpProject/main.c", "int v = 1;\n");
    const { out } = startApp(new Workspace(bench.config()));
    await until(() => out.screen.includes("синхронно"), "live");
    expect(out.screen).toMatch(MASCOT_ROW);

    out.rows = 14; // shrink the window
    out.emit("resize");
    await until(() => out.screen.includes("▀▄ anonymus"), "compact header");
    expect(out.screen).not.toMatch(MASCOT_ROW);
  });

  it("scrolls the journal with the mouse wheel; the arrows stay with the pair list", async () => {
    bench = makeBench();
    bench.write("project", "BIGcorpProject/main.c", "int v = 1;\n");
    const { out, press } = startApp(new Workspace(bench.config()));
    await until(() => out.screen.includes("синхронно"), "live");
    for (let i = 0; i < 40; i++) {
      bench.write("project", `BIGcorpProject/f${String(i).padStart(2, "0")}.c`, `int f${i};\n`);
    }
    await until(() => out.screen.includes("MyProject/f39.c"), "newest transfer shown");

    press("\x1b[<64;5;5M\x1b[<64;5;5M"); // wheel up, two notches
    await until(() => out.screen.includes("история: ниже"), "scrolled back");
    expect(out.screen).not.toContain("MyProject/f39.c");
    press("\x1b[B"); // an arrow key does not scroll
    await new Promise((r) => setTimeout(r, 200));
    expect(out.screen).toContain("история: ниже");

    press("\x1b[<65;5;5M\x1b[<65;5;5M"); // wheel down back to the newest lines
    await until(() => out.screen.includes("MyProject/f39.c"), "back at the newest");
    expect(out.screen).not.toContain("история: ниже");

    // Scrolled back again, a click on "↓ к последним" jumps to the newest lines.
    press("\x1b[<64;5;5M\x1b[<64;5;5M\x1b[<64;5;5M");
    await until(() => out.screen.includes("к последним"), "button shown");
    const lines = out.screen.split("\n");
    const row = lines.findIndex((l) => l.includes("к последним"));
    const col = lines[row].indexOf("↓");
    press(`\x1b[<0;${col + 1};${row + 1}M\x1b[<0;${col + 1};${row + 1}m`);
    await until(() => out.screen.includes("MyProject/f39.c"), "jumped to the newest");
    expect(out.screen).not.toContain("к последним");
  });
});
