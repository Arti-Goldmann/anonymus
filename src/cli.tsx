#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "ink";
import { ConfigError, findConfig, loadConfig } from "./config/loader.js";
import { SERVICE_DIR } from "./config/schema.js";
import { CONFIG_TEMPLATE } from "./config/template.js";
import { SyncEngine } from "./core/engine.js";
import { acquireLock } from "./core/lock.js";
import { applyReconcile, planReconcile, type Strategy } from "./core/reconcile.js";
import { KIND_LABEL, scan } from "./core/scanner.js";
import { Syncer } from "./core/syncer.js";
import { App } from "./ui/App.js";
import { formatTime } from "./ui/theme.js";

const HELP = `anonymus — автоматическая синхронизация проекта и песочницы с анонимизацией

Запуск из корня проекта (там, где лежит anonymus.yaml):

  anonymus              скан, сверка расхождений и живая синхронизация
  anonymus init         создать anonymus.yaml из шаблона
  anonymus scan         только показать расхождения (код 1, если они есть)

Опции:
  -c, --config <файл>   путь к конфигу (по умолчанию ./anonymus.yaml)
  --no-tui              простой построчный вывод вместо интерфейса
  --strategy <s>        для --no-tui: project | sandbox | smart | manual
  -v, --version         версия
  -h, --help            эта справка
`;

interface Args {
  command: "start" | "init" | "scan";
  config?: string;
  tui: boolean;
  strategy?: Strategy;
}

function version(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  try {
    return JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8")).version;
  } catch {
    return "?";
  }
}

const STRATEGIES: Record<string, Strategy> = {
  project: "project-wins",
  sandbox: "sandbox-wins",
  smart: "smart",
  manual: "manual",
};

function parseArgs(argv: string[]): Args {
  const args: Args = { command: "start", tui: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "init" || a === "scan") {
      args.command = a;
    } else if (a === "-c" || a === "--config") {
      args.config = argv[++i];
    } else if (a === "--no-tui") {
      args.tui = false;
    } else if (a === "--strategy") {
      const s = STRATEGIES[argv[++i] ?? ""];
      if (!s) {
        fail(`--strategy: допустимо ${Object.keys(STRATEGIES).join(" | ")}`);
      }
      args.strategy = s;
    } else if (a === "-v" || a === "--version") {
      console.log(version());
      process.exit(0);
    } else if (a === "-h" || a === "--help") {
      console.log(HELP);
      process.exit(0);
    } else {
      fail(`неизвестный аргумент: ${a}\n\n${HELP}`);
    }
  }
  return args;
}

function fail(message: string, code = 2): never {
  console.error(message);
  process.exit(code);
}

function runInit(cwd: string): void {
  const target = path.join(cwd, "anonymus.yaml");
  if (fs.existsSync(target)) {
    fail(`${target} уже существует — не перезаписываю.`);
  }
  fs.writeFileSync(target, CONFIG_TEMPLATE, "utf8");
  console.log(`Создан ${target}`);

  // The config holds real names and .anonymus holds state/backups: keep both out of git.
  const gitignore = path.join(cwd, ".gitignore");
  const existing = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, "utf8") : "";
  const lines = existing.split(/\r?\n/).map((l) => l.trim());
  const missing = ["anonymus.yaml", `${SERVICE_DIR}/`].filter((e) => !lines.includes(e));
  if (missing.length > 0) {
    const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    fs.appendFileSync(gitignore, `${prefix}\n# anonymus (реальные имена и служебные файлы)\n${missing.join("\n")}\n`);
    console.log(`В .gitignore добавлено: ${missing.join(", ")}`);
  }
  console.log("Отредактируйте sandbox, sync.include и replacements, затем запустите `anonymus`.");
}

function load(cwd: string, explicit?: string): { engine: SyncEngine; warnings: string[] } {
  try {
    const { config, warnings } = loadConfig(findConfig(cwd, explicit));
    return { engine: new SyncEngine(config), warnings };
  } catch (e) {
    if (e instanceof ConfigError) {
      fail(`Ошибка в конфиге:\n  - ${e.problems.join("\n  - ")}`);
    }
    throw e;
  }
}

async function runScan(engine: SyncEngine): Promise<void> {
  const result = await scan(engine);
  for (const [kind, n] of Object.entries(result.counts)) {
    if (n > 0 && kind !== "ignored" && kind !== "gone") {
      console.log(`${String(n).padStart(6)}  ${KIND_LABEL[kind as keyof typeof KIND_LABEL]}`);
    }
  }
  for (const s of result.statuses.filter((s) => s.kind !== "synced")) {
    console.log(`  ${KIND_LABEL[s.kind].padEnd(28)} ${s.canonical}`);
  }
  for (const e of result.pathErrors) {
    console.log(`  ошибка пути (${e.side === "project" ? "проект" : "песочница"}) ${e.path}: ${e.problem}`);
  }
  process.exit(result.clean ? 0 : 1);
}

/** Line-by-line mode for non-interactive terminals, logs and CI. */
async function runHeadless(engine: SyncEngine, warnings: string[], strategy?: Strategy): Promise<void> {
  const log = (msg: string) => console.log(`${formatTime(new Date())}  ${msg}`);
  for (const w of warnings) log(`⚠ ${w}`);
  log(`проект   ${engine.projectRoot}`);
  log(`песочница ${engine.sandboxRoot}`);

  const result = await scan(engine);
  let held = result.statuses.filter(() => false);
  if (!result.clean) {
    if (!strategy) {
      fail("Проект и песочница расходятся. Укажите --strategy project|sandbox|smart|manual или запустите без --no-tui.", 1);
    }
    const outcome = await applyReconcile(engine, planReconcile(result, strategy));
    held = outcome.held;
    log(`сверка: перенесено ${outcome.transfers.length}, удалено ${outcome.deleted}, слито ${outcome.merged}, на решение ${outcome.held.length}`);
  } else {
    await applyReconcile(engine, planReconcile(result, "smart"));
  }

  const syncer = new Syncer(engine, held);
  syncer.on("event", (e) => log(`${e.kind.padEnd(10)} ${e.message}`));
  await syncer.start();
  const stop = () => {
    log("останавливаюсь…");
    void syncer.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();

  if (args.command === "init") {
    runInit(cwd);
    return;
  }
  const { engine, warnings } = load(cwd, args.config);

  if (args.command === "scan") {
    await runScan(engine);
    return;
  }

  const lock = acquireLock(engine.state.dir);
  if ("heldBy" in lock) {
    fail(
      `anonymus уже запущен для этого проекта (процесс ${lock.heldBy}).\n` +
        "Два экземпляра мешали бы друг другу — остановите первый (q) и повторите.",
      1
    );
  }
  process.on("exit", lock.release);

  if (!args.tui || !process.stdout.isTTY || !process.stdin.isTTY) {
    await runHeadless(engine, warnings, args.strategy);
    return;
  }
  // Full-screen UI on the alternate screen: resizing redraws one frame instead
  // of leaving copies in the scrollback, and on exit the terminal looks exactly
  // as before the start.
  let onAltScreen = true;
  const leaveAltScreen = () => {
    if (onAltScreen) {
      onAltScreen = false;
      process.stdout.write("\x1b[?1049l");
    }
  };
  process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H");
  process.on("exit", leaveAltScreen);

  const app = render(<App engine={engine} version={version()} warnings={warnings} />, {
    exitOnCtrlC: false,
  });
  await app.waitUntilExit();
  leaveAltScreen();
  console.log(`anonymus остановлен. Журнал: ${path.join(engine.projectRoot, SERVICE_DIR, "anonymus.log")}`);
  process.exit(0);
}

main().catch((e) => fail(`Непредвиденная ошибка: ${(e as Error).stack ?? e}`, 3));
