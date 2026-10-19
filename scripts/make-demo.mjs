// Creates (or resets) a demo stand: demo/proj (the "real" project, a git repo)
// plus empty demo/proj.worktrees (git worktrees of the sub-sandboxes) and
// demo/sandboxes (the sandboxes themselves), and a VS Code workspace showing
// all three.
//
//   npm run demo
//   demo\start.ps1      (n — create the first sub-sandbox)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import iconv from "iconv-lite";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "demo");
const proj = path.join(root, "proj");
const worktrees = path.join(root, "proj.worktrees");
const sandboxes = path.join(root, "sandboxes");

/**
 * Empty a folder but keep the folder itself: it may be the current directory
 * of a terminal or open in VS Code, and Windows refuses to delete such folders.
 */
function clearDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(dir)) {
    forceRm(path.join(dir, name));
  }
}

/** rm -rf that also copes with read-only files (git objects on Windows). */
function forceRm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (e) {
    if (e.code !== "EPERM" && e.code !== "EACCES") throw e;
    const makeWritable = (q) => {
      fs.chmodSync(q, 0o666);
      if (fs.statSync(q).isDirectory()) for (const n of fs.readdirSync(q)) makeWritable(path.join(q, n));
    };
    makeWritable(p);
    fs.rmSync(p, { recursive: true, force: true });
  }
}

fs.mkdirSync(root, { recursive: true });
// The three folders are emptied, not deleted: they may be open in VS Code or a
// terminal. Anything else (an older layout of the stand) goes.
const kept = new Set(["proj", "proj.worktrees", "sandboxes", ".vscode"]);
for (const name of fs.readdirSync(root)) {
  if (!kept.has(name)) {
    forceRm(path.join(root, name));
  }
}
clearDir(proj);
clearDir(worktrees);
clearDir(sandboxes);

const crlf = (s) => s.replace(/\n/g, "\r\n");
function write(rel, content) {
  const p = path.join(proj, ...rel.split("/"));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

// --- Firmware in Windows-1251 with CRLF, like an old embedded project ---
write(
  "BIGcorpProject_cpu01/main.c",
  iconv.encode(
    crlf(`// Прошивка контроллера BIGcorpProject, заказчик ООО Ромашка
// Ответственный: Иван Петров
#include "bigcorp_project.h"
#include "drivers/uart.h"

int main(void)
{
    uart_init(BIGCORP_PROJECT_BAUDRATE);
    uart_print("BIGcorpProject v" BIGCORP_PROJECT_VERSION "\\n");

    while (1) {
        // основной цикл
    }
}
`),
    "win1251"
  )
);
write(
  "BIGcorpProject_cpu01/bigcorp_project.h",
  iconv.encode(
    crlf(`#ifndef BIGCORP_PROJECT_H
#define BIGCORP_PROJECT_H

// Настройки платы BIGcorpProject
#define BIGCORP_PROJECT_VERSION  "1.4.2"
#define BIGCORP_PROJECT_BAUDRATE 115200

#endif
`),
    "win1251"
  )
);
write(
  "BIGcorpProject_cpu01/drivers/uart.h",
  crlf(`#pragma once
void uart_init(unsigned long baud);
void uart_print(const char *s);
`)
);
write(
  "BIGcorpProject_cpu01/drivers/uart.c",
  crlf(`#include "uart.h"

// UART driver for the bigcorpProject board
void uart_init(unsigned long baud) { (void)baud; }
void uart_print(const char *s) { (void)s; }
`)
);

// --- Tools and docs in UTF-8 / LF ---
write(
  "tools/flash.py",
  `"""Flash the BIGcorpProject firmware. Support: https://romashka.ru/support"""

BOARD = "bigcorp_project_cpu01"

def main():
    print(f"Flashing {BOARD}...")

if __name__ == "__main__":
    main()
`
);
write(
  "docs/README.md",
  `# BIGcorpProject

Прошивка для ООО Ромашка. Документация: https://romashka.ru/docs

Контакт: Иван Петров.
`
);
write("img/logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]));

// --- Things that must NOT reach the sandbox ---
write(".venv/lib/site.py", "# virtualenv\n");
write(".venv-ubuntu/lib/site.py", "# another virtualenv\n");
write("build/firmware.hex", ":00000001FF\n"); // root build/ — excluded
write("secrets/api.key", "SUPER-SECRET\n");
// A nested "build" folder IS synced: /build only excludes the root one.
write("BIGcorpProject_cpu01/build/README.txt", "Build notes for BIGcorpProject.\n");

write(
  "anonymus.yaml",
  `# Демо-конфиг anonymus
version: 1
# Песочницы подпесочниц; их git worktree — в ../proj.worktrees (по умолчанию).
sandboxes_dir: ../sandboxes

sync:
  include: ["**"]
  exclude:
    - .venv*        # .venv и .venv-ubuntu
    - /build        # только build/ в корне
    - secrets/
  encoding: auto
  sandbox_encoding: keep
  debounce_ms: 300

replacements:
  - real: "BIGcorpProject"
    placeholder: "MyProject"
    variants: auto
  - real: "ООО Ромашка"
    placeholder: "ACME Corp"
    variants: exact
  - real: "romashka.ru"
    placeholder: "example.com"
    variants: exact
  - real: "Иван Петров"
    placeholder: "John Doe"
    variants: exact
`
);

// The project is a git repo so sub-sandboxes per branch can be tried out.
// Real-names config and anonymus' service folder stay out of git.
write(".gitignore", "anonymus.yaml\n.anonymus/\n.venv*/\n/build/\nsecrets/\n");
const git = (...args) => execFileSync("git", args, { cwd: proj, stdio: ["ignore", "pipe", "pipe"] });
git("init", "--quiet", "--initial-branch=master");
git("config", "user.name", "demo");
git("config", "user.email", "demo@example.com");
git("config", "core.autocrlf", "false"); // keep CRLF / LF exactly as written on checkout
git("add", "-A");
git("commit", "--quiet", "-m", "Прошивка BIGcorpProject 1.4.2");

fs.writeFileSync(
  path.join(root, "demo.code-workspace"),
  JSON.stringify(
    {
      folders: [
        { name: "ПРОЕКТ (реальные имена)", path: "proj" },
        { name: "WORKTREE ПОДПЕСОЧНИЦ (реальные имена)", path: "proj.worktrees" },
        { name: "ПЕСОЧНИЦЫ (плейсхолдеры)", path: "sandboxes" },
      ],
      // Each worktree is a git repository one level down: Source Control
      // shows every one of them with its own changes.
      settings: { "files.autoGuessEncoding": true, "git.repositoryScanMaxDepth": 1, "scm.defaultViewMode": "tree", "terminal.integrated.tabs.title": "${sequence}" },
    },
    null,
    2
  )
);
// The demo folder opened as is: worktrees are two levels down
// (demo/proj.worktrees/<name>), deeper than VS Code scans by default.
fs.mkdirSync(path.join(root, ".vscode"), { recursive: true });
fs.writeFileSync(
  path.join(root, ".vscode", "settings.json"),
  JSON.stringify({ "files.autoGuessEncoding": true, "git.repositoryScanMaxDepth": 2, "scm.defaultViewMode": "tree", "terminal.integrated.tabs.title": "${sequence}" }, null, 2)
);

// Launcher that does not depend on PATH: calls node.exe and the built CLI by
// absolute paths, so it works even in terminals started before Node was installed.
fs.writeFileSync(
  path.join(root, "start.ps1"),
  `# Starts anonymus on the demo stand without relying on PATH.
$node = Join-Path $env:ProgramFiles "nodejs\\node.exe"
if (-not (Test-Path $node)) { $node = "node" }
$cli = Join-Path $PSScriptRoot "..\\dist\\cli.js"
Set-Location (Join-Path $PSScriptRoot "proj")
& $node $cli @args
`
);

console.log(`Демо-стенд создан: ${root}
  проект:     ${proj}
  worktree:   ${worktrees} (пусто)
  песочницы:  ${sandboxes} (пусто)

Дальше:
  code "${path.join(root, "demo.code-workspace")}"
  & "${path.join(root, "start.ps1")}"     затем n — первая подпесочница`);
