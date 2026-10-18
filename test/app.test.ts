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

describe("App: sub-sandbox workflow end to end", () => {
  let bench: Bench;
  let unmount: (() => void) | null = null;
  afterEach(async () => {
    unmount?.();
    unmount = null;
    await new Promise((r) => setTimeout(r, 200)); // let watchers close
    bench?.cleanup();
  });

  it("folds the mascot, creates a sub-sandbox for a new branch and switches back", async () => {
    bench = makeBench();
    bench.write("project", "BIGcorpProject/main.c", "int v = 1; // BIGcorpProject\n");
    bench.gitInit();

    const out = new FakeStdout();
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
    const ws = new Workspace(bench.config());
    const app = render(React.createElement(App, { workspace: ws, version: "test", warnings: [] }), {
      stdout: out as never,
      stdin: stdin as never,
      patchConsole: false,
      exitOnCtrlC: false,
    });
    unmount = () => app.unmount();
    const press = (keys: string) => stdin.write(keys);
    (globalThis as { __screen?: () => string }).__screen = () => out.screen;

    // Empty sandbox is filled automatically, then live sync with a folded header.
    await until(() => out.screen.includes("синхронизация активна"), "live sync");
    expect(out.screen).not.toMatch(MASCOT_ROW);
    expect(out.screen).toContain("default ⎇ master");
    expect(bench.read("sandbox", "MyProject/main.c")).toBe("int v = 1; // MyProject\n");

    // b → n → name → Enter: new branch + sub-sandbox, synced right away.
    press("b");
    await until(() => out.screen.includes("Подпесочницы"), "sandboxes screen");
    press("n");
    await until(() => out.screen.includes("Имя новой ветки"), "name input");
    press("feature-x");
    await until(() => out.screen.includes("папка"), "preview of the new folder");
    press("\r");
    await until(
      () => out.screen.includes("feature-x ⎇ feature-x") && out.screen.includes("синхронизация активна"),
      "switched to feature-x"
    );
    expect(bench.git("branch", "--show-current")).toBe("feature-x");
    const folder = path.join(path.dirname(bench.sandbox), "feature-x");
    expect(fs.readFileSync(path.join(folder, "MyProject", "main.c"), "utf8")).toBe("int v = 1; // MyProject\n");

    // An edit in the new sub-sandbox reaches the project (on branch feature-x).
    fs.writeFileSync(path.join(folder, "MyProject", "main.c"), "int v = 2; // MyProject\n");
    await until(() => bench.read("project", "BIGcorpProject/main.c") === "int v = 2; // BIGcorpProject\n", "sync to project");

    // Back to default: the edit is stashed with feature-x, master is clean.
    press("b");
    await until(() => out.screen.includes("Подпесочницы"), "sandboxes screen again");
    press("\x1b[A"); // up: default is listed first
    await until(() => out.screen.includes("❯ ○ default"), "default selected");
    press("\r");
    await until(
      () => out.screen.includes("default ⎇ master") && out.screen.includes("синхронизация активна"),
      "switched back to default"
    );
    expect(bench.git("branch", "--show-current")).toBe("master");
    expect(bench.read("project", "BIGcorpProject/main.c")).toBe("int v = 1; // BIGcorpProject\n");
    expect(ws.registry.get("feature-x")!.stash).toMatch(/^anonymus:feature-x:/);
  }, 60000);
});
