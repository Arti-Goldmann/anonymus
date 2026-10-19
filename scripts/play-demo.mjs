// Plays a scripted session on one pair of the demo stand while `anonymus` is running:
//   1. an AI agent works in the sandbox (placeholder names only);
//   2. a developer works in the pair's worktree (real names);
//   3. both edit at the same time: one clean auto-merge, one real conflict.
//
//   npm run demo          # fresh stand
//   demo\start.ps1        # in one terminal: start anonymus, n — create a pair
//   npm run demo:play     # in another terminal: watch the log in the first one
//   (PAIR=<name> picks the pair; the first one by default)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import iconv from "iconv-lite";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "demo");
const PROJ = path.join(root, "proj");

/** The pair to play on: its worktree (project side) and its sandbox. */
function pickPair() {
  let pairs = [];
  try {
    pairs = JSON.parse(fs.readFileSync(path.join(PROJ, ".anonymus", "sandboxes.json"), "utf8")).sandboxes ?? [];
  } catch {
    // no pairs yet
  }
  const pair = process.env.PAIR ? pairs.find((p) => p.name === process.env.PAIR) : pairs[0];
  if (!pair) {
    console.error("На стенде нет подпесочниц: запустите demo\\start.ps1 и создайте её клавишей n.");
    process.exit(1);
  }
  console.log(`подпесочница «${pair.name}»: ${pair.worktree} ⇄ ${pair.sandbox}`);
  return pair;
}
const PAIR = pickPair();
const P = PAIR.worktree;
const S = PAIR.sandbox;
const STEP_MS = Number(process.env.STEP_MS ?? 1500);
const PHASE_MS = Number(process.env.PHASE_MS ?? 4000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toLocaleTimeString("ru-RU", { hour12: false });
const say = (who, msg) => console.log(`${stamp()}  ${who.padEnd(11)} ${msg}`);

function isUtf8(bytes) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Read a text file in whatever encoding it uses (UTF-8 or Windows-1251). */
function read(file) {
  const bytes = fs.readFileSync(file);
  const enc = isUtf8(bytes) ? "utf8" : "win1251";
  return { text: enc === "utf8" ? bytes.toString("utf8") : iconv.decode(bytes, "win1251"), enc };
}

function write(file, text, enc = "utf8") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, enc === "win1251" ? iconv.encode(text, "win1251") : Buffer.from(text, "utf8"));
}

/** Change a file in place, keeping its encoding (eol: force a line-ending style). */
function edit(file, change, eol) {
  const { text, enc } = read(file);
  let next = change(text);
  if (eol === "\n") next = next.replace(/\r\n/g, "\n");
  if (next === text) throw new Error(`edit had no effect: ${file}`);
  write(file, next, enc);
}

function requireRunning() {
  const lock = path.join(PROJ, ".anonymus", "lock");
  const sandboxReady = fs.existsSync(path.join(S, "MyProject_cpu01", "main.c"));
  let running = false;
  try {
    process.kill(Number(fs.readFileSync(lock, "utf8")), 0);
    running = true;
  } catch {
    running = false;
  }
  if (!running || !sandboxReady) {
    console.error(
      "Сначала запустите anonymus на стенде и создайте подпесочницу:\n" +
        "  npm run demo\n  demo\\start.ps1   (n, имя, Enter)\n" +
        "и в другом терминале снова npm run demo:play"
    );
    process.exit(1);
  }
}

async function step(who, msg, action) {
  action();
  say(who, msg);
  await sleep(STEP_MS);
}

requireRunning();
const s = (rel) => path.join(S, ...rel.split("/"));
const p = (rel) => path.join(P, ...rel.split("/"));

console.log("\n=== Акт 1: ИИ-агент работает в песочнице (видит только плейсхолдеры) ===\n");

await step("песочница", "main.c: watchdog + подключение SPI (агент сохранил с LF)", () =>
  edit(
    s("MyProject_cpu01/main.c"),
    (t) =>
      t
        .replace('#include "drivers/uart.h"', '#include "drivers/uart.h"\r\n#include "drivers/spi.h"\r\n#include "drivers/watchdog.h"')
        .replace("    uart_init(MY_PROJECT_BAUDRATE);", "    watchdog_init(2000);\r\n    spi_init();\r\n    uart_init(MY_PROJECT_BAUDRATE);")
        .replace("        // основной цикл", "        watchdog_kick();\r\n        // основной цикл"),
    "\n"
  )
);
await step("песочница", "my_project.h: версия 1.5.0", () =>
  edit(s("MyProject_cpu01/my_project.h"), (t) => t.replace('"1.4.2"', '"1.5.0"'))
);
await step("песочница", "uart.c: реализация драйвера", () =>
  write(
    s("MyProject_cpu01/drivers/uart.c"),
    `#include "uart.h"

// UART driver for the myProject board
void uart_init(unsigned long baud)
{
    (void)baud; // TODO: configure USART1
}

void uart_print(const char *s)
{
    while (*s) {
        uart_putc(*s++);
    }
}
`
  )
);
await step("песочница", "новый spi.h", () =>
  write(s("MyProject_cpu01/drivers/spi.h"), `#pragma once\n// SPI bus of the MyProject board\nvoid spi_init(void);\nunsigned char spi_transfer(unsigned char b);\n`)
);
await step("песочница", "новый spi.c", () =>
  write(
    s("MyProject_cpu01/drivers/spi.c"),
    `#include "spi.h"\n#include "../my_project.h"\n\nvoid spi_init(void) { }\n\nunsigned char spi_transfer(unsigned char b)\n{\n    return b; // loopback until MY_PROJECT_SPI is wired\n}\n`
  )
);
await step("песочница", "новый watchdog.c", () =>
  write(s("MyProject_cpu01/drivers/watchdog.c"), `// Independent watchdog for MyProject\nvoid watchdog_init(unsigned ms) { (void)ms; }\nvoid watchdog_kick(void) { }\n`)
);
await step("песочница", "flash.py: аргументы командной строки", () =>
  edit(s("tools/flash.py"), (t) =>
    t
      .replace('BOARD = "my_project_cpu01"', 'import argparse\n\nBOARD = "my_project_cpu01"')
      .replace("def main():\n", 'def main():\n    parser = argparse.ArgumentParser(description="Flash MyProject")\n    parser.add_argument("--port", default="COM3")\n    args = parser.parse_args()\n')
  )
);
await step("песочница", "README.md: раздел «Сборка»", () =>
  edit(s("docs/README.md"), (t) => t + "\n## Сборка\n\n```\ncmake -B build -DBOARD=my_project_cpu01\ncmake --build build\n```\n\nВопросы по прошивке — ACME Corp, https://example.com/support\n")
);
await step("песочница", "новый тест tests/test_flash.py", () =>
  write(s("tests/test_flash.py"), `from tools import flash\n\n\ndef test_board_name():\n    assert flash.BOARD == "my_project_cpu01"\n`)
);
await step("песочница", "удалён MyProject_cpu01/build/README.txt", () =>
  fs.rmSync(s("MyProject_cpu01/build/README.txt"))
);

await sleep(PHASE_MS);
console.log("\n=== Акт 2: разработчик работает в проекте (реальные имена) ===\n");

await step("проект", "uart.h: объявление uart_read", () =>
  edit(p("BIGcorpProject_cpu01/drivers/uart.h"), (t) => t.replace("void uart_print(const char *s);", "void uart_print(const char *s);\r\nint uart_read(void);"))
);
await step("проект", "bigcorp_project.h: скорость SPI (win1251)", () =>
  edit(p("BIGcorpProject_cpu01/bigcorp_project.h"), (t) =>
    t.replace("#define BIGCORP_PROJECT_BAUDRATE 115200", "#define BIGCORP_PROJECT_BAUDRATE 115200\r\n// Частота шины SPI для ООО Ромашка\r\n#define BIGCORP_PROJECT_SPI_HZ   8000000")
  )
);
await step("проект", "новый docs/CHANGELOG.md", () =>
  write(p("docs/CHANGELOG.md"), `# Изменения BIGcorpProject\n\n## 1.5.0\n- SPI и watchdog по запросу ООО Ромашка\n- Подробности: https://romashka.ru/releases/1.5.0\n`)
);
await step("проект", "flash.py: таймаут прошивки", () =>
  edit(p("tools/flash.py"), (t) => t.replace('BOARD = "bigcorp_project_cpu01"', 'BOARD = "bigcorp_project_cpu01"\nTIMEOUT_S = 30'))
);
await step("проект", "новый config/board.h (win1251)", () =>
  write(p("BIGcorpProject_cpu01/config/board.h"), "#pragma once\r\n// Распиновка платы BIGcorpProject, ревизия B\r\n#define LED_PIN   13\r\n#define SPI_CS    10\r\n", "win1251")
);
await step("проект", "новый tools/requirements.txt", () => write(p("tools/requirements.txt"), "pyserial==3.5\n"));
await step("проект", "README.md: ответственный за релиз", () =>
  edit(p("docs/README.md"), (t) => t.replace("Контакт: Иван Петров.", "Контакт: Иван Петров.\nРелиз 1.5.0 согласован с ООО Ромашка."))
);
await step("проект", "spi.c (созданный агентом): комментарий разработчика", () =>
  edit(p("BIGcorpProject_cpu01/drivers/spi.c"), (t) => t.replace("void spi_init(void) { }", "// Reviewed for BIGcorpProject rev. B\nvoid spi_init(void) { }"))
);
await step("проект", "новая картинка img/board.png (бинарный файл)", () =>
  write(p("img/board.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7, 6]))
);
await step("проект", "новый docs/team.md — с написанием, которого нет в заменах (утечка!)", () =>
  write(p("docs/team.md"), "# Команда\n\nBigcorp Project team: прошивка и инструменты.\n")
);

await sleep(PHASE_MS);
console.log("\n=== Акт 3: одновременные правки с двух сторон ===\n");

// Different lines of one file, at the same moment -> clean 3-way merge.
edit(s("MyProject_cpu01/drivers/uart.c"), (t) => t.replace("(void)baud; // TODO: configure USART1", "USART1->BRR = 72000000u / baud;"));
edit(p("BIGcorpProject_cpu01/drivers/uart.c"), (t) => t.replace("// UART driver for the bigcorpProject board", "// UART driver for the bigcorpProject board (rev. B)"));
say("обе стороны", "uart.c: разные строки одновременно — ждём автослияния");
await sleep(STEP_MS * 2);

// The same line on both sides -> a real conflict, left for the user.
edit(s("MyProject_cpu01/main.c"), (t) => t.replace("uart_init(MY_PROJECT_BAUDRATE);", "uart_init(MY_PROJECT_BAUDRATE * 2);"));
edit(p("BIGcorpProject_cpu01/main.c"), (t) => t.replace("uart_init(BIGCORP_PROJECT_BAUDRATE);", "uart_init(9600);"));
say("обе стороны", "main.c: одна и та же строка — будет конфликт");

console.log(`
Готово. В окне anonymus:
  • в ленте — переносы в обе стороны, удаление, «⚠ возможная утечка» для docs/team.md,
    автослияние uart.c;
  • внизу «! 1 файл ждёт решения» — нажмите c, затем
      p — оставить версию проекта, s — версию песочницы, m — слить в VS Code.
`);
