// Creates (or resets) a demo stand: demo/proj (the "real" project) and an
// empty demo/sandbox, plus a VS Code workspace showing both side by side.
//
//   npm run demo
//   cd demo\proj
//   anonymus

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import iconv from "iconv-lite";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "demo");
const proj = path.join(root, "proj");
const sandbox = path.join(root, "sandbox");

/**
 * Empty a folder but keep the folder itself: it may be the current directory
 * of a terminal or open in VS Code, and Windows refuses to delete such folders.
 */
function clearDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

fs.mkdirSync(root, { recursive: true });
for (const name of fs.readdirSync(root)) {
  if (name !== "proj" && name !== "sandbox") {
    fs.rmSync(path.join(root, name), { recursive: true, force: true });
  }
}
clearDir(proj);
clearDir(sandbox);

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
sandbox: ../sandbox

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

fs.writeFileSync(
  path.join(root, "demo.code-workspace"),
  JSON.stringify(
    {
      folders: [
        { name: "ПРОЕКТ (реальные имена)", path: "proj" },
        { name: "ПЕСОЧНИЦА (плейсхолдеры)", path: "sandbox" },
      ],
      settings: { "files.autoGuessEncoding": true },
    },
    null,
    2
  )
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
  проект:    ${proj}
  песочница: ${sandbox} (пустая)

Дальше:
  code "${path.join(root, "demo.code-workspace")}"
  & "${path.join(root, "start.ps1")}"`);
