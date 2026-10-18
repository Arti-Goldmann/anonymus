#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "ink";
import { ConfigError, findConfig, loadConfig } from "./config/loader.js";
import { SERVICE_DIR } from "./config/schema.js";
import { CONFIG_TEMPLATE } from "./config/template.js";
import type { SyncEngine } from "./core/engine.js";
import { acquireLock } from "./core/lock.js";
import { Workspace } from "./core/workspace.js";
import { applyReconcile, planReconcile, type Strategy } from "./core/reconcile.js";
import { KIND_LABEL, scan } from "./core/scanner.js";
import { Syncer } from "./core/syncer.js";
import { App } from "./ui/App.js";
import { flickerFreeStdout } from "./ui/frameStdout.js";
import { formatTime } from "./ui/theme.js";

const HELP = `anonymus — автоматическая синхронизация проекта и песочницы с анонимизацией

Запуск из корня проекта (там, где лежит anonymus.yaml):

  anonymus              скан, сверка расхождений и живая синхронизация
  anonymus init         создать anonymus.yaml из шаблона
  anonymus scan         только показать расхождения (код 1, если они есть)

Подпесочницы (по одной на git-ветку проекта):
  anonymus sandboxes                  список
  anonymus sandbox new <имя>          новая ветка от текущей + подпесочница
  anonymus sandbox switch <имя>       переключить проект на ветку подпесочницы
  anonymus sandbox remove <имя>       удалить подпесочницу (папка в корзину)

Опции:
  -c, --config <файл>   путь к конфигу (по умолчанию ./anonymus.yaml)
  --no-tui              простой построчный вывод вместо интерфейса
  --strategy <s>        для --no-tui: project | sandbox | smart | manual
  -v, --version         версия
  -h, --help            эта справка
`;

type SandboxAction = "new" | "switch" | "remove";

interface Args {
  command: "start" | "init" | "scan" | "sandboxes" | "sandbox";
  sandboxAction?: SandboxAction;
  sandboxName?: string;
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
    if (a === "init" || a === "scan" || a === "sandboxes") {
      args.command = a;
    } else if (a === "sandbox") {
      const action = argv[++i];
      const name = argv[++i];
      if (action !== "new" && action !== "switch" && action !== "remove") {
        fail("sandbox: укажите new | switch | remove и имя");
      }
      if (!name) {
        fail(`sandbox ${action}: укажите имя подпесочницы`);
      }
      args.command = "sandbox";
      args.sandboxAction = action;
      args.sandboxName = name;
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

function load(cwd: string, explicit?: string): { workspace: Workspace; warnings: string[] } {
  try {
    const { config, warnings } = loadConfig(findConfig(cwd, explicit));
    return { workspace: new Workspace(config), warnings };
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

function printSandboxes(workspace: Workspace): void {
  if (!workspace.gitEnabled) {
    console.log("(проект не git-репозиторий — доступна только подпесочница default)");
  }
  for (const s of workspace.registry.list()) {
    const mark = s.name === workspace.active.name ? "●" : "○";
    const extra = [s.stash ? "есть stash" : "", fs.existsSync(workspace.registry.absPath(s)) ? "" : "папка не найдена"]
      .filter(Boolean)
      .join(", ");
    console.log(`${mark} ${s.name.padEnd(24)} ⎇ ${(s.branch ?? "—").padEnd(24)} ${workspace.registry.absPath(s)}${extra ? `  (${extra})` : ""}`);
  }
}

function runSandboxCommand(workspace: Workspace, action: SandboxAction, name: string): void {
  const step = (m: string) => console.log(`  … ${m}`);
  try {
    let warnings: string[] = [];
    if (action === "new") {
      warnings = workspace.create(name, step).warnings;
    } else if (action === "switch") {
      warnings = workspace.switchTo(name, step);
    } else {
      warnings = workspace.remove(name, step).warnings;
    }
    warnings.forEach((w) => console.log(`⚠ ${w}`));
    console.log("готово.");
    printSandboxes(workspace);
    if (action !== "remove") {
      console.log("Запустите anonymus, чтобы синхронизировать активную подпесочницу.");
    }
  } catch (e) {
    fail(`Ошибка: ${(e as Error).message}`, 1);
  }
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
  const { workspace, warnings } = load(cwd, args.config);
  const notices = workspace.reconcileWithGit();

  if (args.command === "scan") {
    notices.forEach((n) => console.log(`${n.kind === "warning" ? "⚠" : "·"} ${n.message}`));
    await runScan(workspace.engineFor());
    return;
  }
  if (args.command === "sandboxes") {
    printSandboxes(workspace);
    return;
  }

  // One running anonymus per project, whatever sub-sandbox is active: two
  // instances would fight over the checked-out branch.
  const lock = acquireLock(path.join(workspace.config.projectRoot, SERVICE_DIR));
  if ("heldBy" in lock) {
    fail(
      `anonymus уже запущен для этого проекта (процесс ${lock.heldBy}).\n` +
        "Два экземпляра мешали бы друг другу — остановите первый (q) и повторите.",
      1
    );
  }
  process.on("exit", lock.release);

  if (args.command === "sandbox") {
    runSandboxCommand(workspace, args.sandboxAction!, args.sandboxName!);
    return;
  }

  if (!args.tui || !process.stdout.isTTY || !process.stdin.isTTY) {
    await runHeadless(
      workspace.engineFor(),
      [...warnings, ...notices.map((n) => n.message)],
      args.strategy
    );
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

  const app = render(<App workspace={workspace} version={version()} warnings={warnings} />, {
    stdout: flickerFreeStdout(process.stdout),
    exitOnCtrlC: false,
    patchConsole: false,
  });
  await app.waitUntilExit();
  leaveAltScreen();
  console.log(`anonymus остановлен. Журнал: ${path.join(workspace.config.projectRoot, SERVICE_DIR, "anonymus.log")}`);
  process.exit(0);
}

main().catch((e) => fail(`Непредвиденная ошибка: ${(e as Error).stack ?? e}`, 3));
