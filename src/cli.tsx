#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "ink";
import { ConfigError, findConfig, loadConfig } from "./config/loader.js";
import { SERVICE_DIR } from "./config/schema.js";
import { CONFIG_TEMPLATE } from "./config/template.js";
import { abortMerge, continueMerge, startMerge, type MergeOutcome } from "./core/gitMerge.js";
import { acquireLock } from "./core/lock.js";
import { defaultMergeSources } from "./core/mergePrep.js";
import { RegistryFormatError } from "./core/registry.js";
import { applyReconcile, planReconcile, type Strategy } from "./core/reconcile.js";
import { KIND_LABEL, scan } from "./core/scanner.js";
import { Syncer } from "./core/syncer.js";
import { decodeText } from "./core/fileio.js";
import { Transformer } from "./core/transformer.js";
import { Workspace } from "./core/workspace.js";
import { App } from "./ui/App.js";
import { flickerFreeStdout } from "./ui/frameStdout.js";
import { MOUSE_OFF, MOUSE_ON, mouseFilteredStdin } from "./ui/mouse.js";
import { formatTime } from "./ui/theme.js";

const HELP = `anonymus — автоматическая синхронизация проекта и песочниц с анонимизацией

Запуск из корня проекта (там, где лежит anonymus.yaml):

  anonymus              проверка, сверка и живая синхронизация всех подпесочниц
  anonymus init         создать anonymus.yaml из шаблона
  anonymus scan         только показать расхождения (код 1, если они есть)
  anonymus check "<текст>"        как текст будет выглядеть в песочнице: результат и сработавшие правила
  anonymus check --file <путь>    то же для файла: изменённые строки и найденные утечки

Подпесочницы (git-проект: у каждой своя ветка и свой git worktree рядом с проектом):
  anonymus sandboxes                    список и состояние
  anonymus sandbox new <имя> [--from <ветка>]
                                        ветка (новая от текущей или --from; или существующая),
                                        её worktree и песочница
  anonymus sandbox remove <имя> [--force]
                                        удалить: песочница — в корзину, worktree — git worktree remove,
                                        ветка остаётся; --force — даже с незакоммиченным в worktree

Слияние работы нескольких агентов (git merge в worktree цели):
  anonymus merge <цель> [<источник>...] закоммитить работу источников (по умолчанию — подпесочницы,
                                        созданные от цели) и слить их по очереди
  anonymus merge --continue <цель>      конфликты разрешены — закоммитить и слить дальше
  anonymus merge --abort <цель>         прервать слияние
  anonymus commit <имя> [-m <сообщение>]
                                        закоммитить незакоммиченное в worktree подпесочницы

Опции:
  -c, --config <файл>   путь к конфигу (по умолчанию ./anonymus.yaml)
  --no-tui              простой построчный вывод вместо интерфейса
  --strategy <s>        для --no-tui: project | sandbox | smart | manual
  -v, --version         версия
  -h, --help            эта справка
`;

type SandboxAction = "new" | "remove";

interface Args {
  command: "start" | "init" | "scan" | "sandboxes" | "sandbox" | "merge" | "commit" | "check";
  /** check: a text to try, or a file with --file. */
  checkText?: string;
  checkFile?: string;
  sandboxAction?: SandboxAction;
  name?: string;
  from?: string;
  force?: boolean;
  mergeMode?: "start" | "continue" | "abort";
  mergeSources?: string[];
  message?: string;
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
    } else if (a === "check") {
      args.command = "check";
      if (argv[i + 1] === "--file") {
        i++;
        args.checkFile = argv[++i];
      } else {
        args.checkText = argv[++i];
      }
      if (!args.checkFile && args.checkText === undefined) {
        fail('check: укажите текст в кавычках или --file <путь>');
      }
    } else if (a === "sandbox") {
      const action = argv[++i];
      const name = argv[++i];
      if (action !== "new" && action !== "remove") {
        fail("sandbox: укажите new | remove и имя");
      }
      if (!name) {
        fail(`sandbox ${action}: укажите имя подпесочницы`);
      }
      args.command = "sandbox";
      args.sandboxAction = action;
      args.name = name;
    } else if (a === "merge") {
      args.command = "merge";
      args.mergeMode = "start";
      if (argv[i + 1] === "--continue" || argv[i + 1] === "--abort") {
        args.mergeMode = argv[++i] === "--continue" ? "continue" : "abort";
      }
      args.name = argv[++i];
      if (!args.name || args.name.startsWith("-")) {
        fail("merge: укажите подпесочницу-цель, в которую сливать");
      }
      args.mergeSources = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
        args.mergeSources.push(argv[++i]);
      }
    } else if (a === "commit") {
      args.command = "commit";
      args.name = argv[++i];
      if (!args.name || args.name.startsWith("-")) {
        fail("commit: укажите подпесочницу");
      }
    } else if (a === "--from") {
      args.from = argv[++i];
    } else if (a === "--force") {
      args.force = true;
    } else if (a === "-m" || a === "--message") {
      args.message = argv[++i];
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

/** OSC 0: set the terminal window / tab title. */
function terminalTitle(title: string): string {
  return `\x1b]0;${title}\x07`;
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
  console.log("Отредактируйте sandbox / sandboxes_dir, sync.include и replacements, затем запустите `anonymus`.");
}

function load(cwd: string, explicit?: string): { workspace: Workspace; warnings: string[] } {
  try {
    const { config, warnings } = loadConfig(findConfig(cwd, explicit));
    return { workspace: new Workspace(config), warnings };
  } catch (e) {
    if (e instanceof ConfigError) {
      fail(`Ошибка в конфиге:\n  - ${e.problems.join("\n  - ")}`);
    }
    if (e instanceof RegistryFormatError) {
      fail(e.message, 1);
    }
    throw e;
  }
}

async function runScan(workspace: Workspace): Promise<void> {
  let clean = true;
  for (const pair of workspace.pairs()) {
    const engine = workspace.engineFor(pair.name);
    const problem = workspace.check(pair.name, engine.state.size > 0);
    const title = workspace.gitEnabled ? `«${pair.name}»: ` : "";
    if (problem) {
      console.log(`${title}✖ ${problem.message}`);
      clean = false;
      continue;
    }
    const result = await scan(engine);
    console.log(`${title}${result.clean ? "совпадают" : "расходятся"}`);
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
    clean &&= result.clean;
  }
  process.exit(clean ? 0 : 1);
}

/** Show characters that look alike but are not: no-break spaces, typographic quotes, tabs. */
function visible(s: string): string {
  return s.replace(/[   ]/g, "⍽").replace(/\t/g, "→");
}

/**
 * `anonymus check`: how a text or a file looks after anonymization with the
 * current anonymus.yaml — to find out why a name was (not) replaced without
 * starting a sync.
 */
function runCheck(workspace: Workspace, args: Args): void {
  const t = new Transformer(workspace.config.replacements);
  let text: string;
  if (args.checkFile) {
    const file = path.resolve(args.checkFile);
    if (!fs.existsSync(file)) {
      fail(`нет файла ${file}`, 1);
    }
    const decoded = decodeText(fs.readFileSync(file), workspace.config.sync.encoding);
    console.log(`файл ${file}: кодировка ${decoded.encoding}${decoded.bom ? " + BOM" : ""}, концы строк ${decoded.eol === "\r\n" ? "CRLF" : "LF"}`);
    text = decoded.text;
  } else {
    text = args.checkText!;
  }
  const result = t.anonymize(text);
  if (args.checkFile) {
    const before = text.split(/\r?\n/);
    const after = result.text.split(/\r?\n/);
    if (before.length === after.length) {
      before.forEach((line, i) => {
        if (line !== after[i]) {
          console.log(`  ${String(i + 1).padStart(5)}  − ${visible(line)}`);
          console.log(`         + ${visible(after[i])}`);
        }
      });
    } else {
      console.log("  (многострочные замены изменили число строк — построчное сравнение не показываю)");
    }
  } else {
    console.log(`было:  ${visible(text)}`);
    console.log(`стало: ${visible(result.text)}`);
  }
  if (result.applied.length === 0) {
    console.log("ни одно правило не сработало");
  }
  for (const a of result.applied) {
    console.log(`сработало ×${a.count}: ${JSON.stringify(a.from)} → ${JSON.stringify(a.to)}`);
  }
  const leaks = t.findLeaks(result.text);
  for (const leak of leaks) {
    console.log(`⚠ осталось реальное имя: ${JSON.stringify(leak)}`);
  }
  if (/[   «»„“”]/.test(text)) {
    console.log("в тексте есть неразрывные пробелы (⍽) или типографские кавычки «» “” — правило должно содержать ровно их");
  }
  process.exit(leaks.length > 0 ? 1 : 0);
}

function printSandboxes(workspace: Workspace): void {
  if (!workspace.gitEnabled) {
    console.log("(проект не git-репозиторий — одна пара: папка проекта ⇄ sandbox)");
  }
  const pairs = workspace.pairs();
  if (pairs.length === 0) {
    console.log("подпесочниц нет — anonymus sandbox new <имя>");
  }
  for (const p of pairs) {
    const problem = workspace.check(p.name, true);
    const mark = problem ? "✖" : p.entry?.merge?.current ? "⇄" : "●";
    const base = p.entry?.base ? ` от ${p.entry.base.branch}` : "";
    console.log(`${mark} ${p.name.padEnd(24)} ⎇ ${(p.branch ?? "—") + base}`);
    console.log(`    worktree  ${p.projectDir}`);
    console.log(`    песочница ${p.sandboxDir}`);
    if (problem) console.log(`    ✖ ${problem.message}`);
    if (p.entry?.merge?.current) console.log(`    ⇄ слияние ${p.entry.merge.current}: разрешите конфликты, затем merge --continue`);
  }
}

async function runSandboxCommand(workspace: Workspace, action: SandboxAction, name: string, args: Args): Promise<void> {
  const step = (m: string) => console.log(`  … ${m}`);
  try {
    if (action === "new") {
      await workspace.create(name, { from: args.from }, step, (m) => console.log(`⚠ ${m}`));
      console.log("готово. Запустите anonymus — песочница заполнится из worktree.");
    } else {
      const { warnings } = workspace.remove(name, { force: args.force }, step);
      warnings.forEach((w) => console.log(`⚠ ${w}`));
      console.log("готово.");
    }
    printSandboxes(workspace);
  } catch (e) {
    fail(`Ошибка: ${(e as Error).message}`, 1);
  }
}

/** Pairs that are not in sync right now cannot take part in a merge run from the CLI. */
async function settledMap(workspace: Workspace, names: string[]): Promise<Map<string, string>> {
  const reasons = new Map<string, string>();
  for (const name of names) {
    const engine = workspace.engineFor(name);
    const problem = workspace.check(name, engine.state.size > 0);
    if (problem) {
      reasons.set(name, problem.message);
    } else if (!(await scan(engine)).clean) {
      reasons.set(name, "проект и песочница расходятся — запустите anonymus, чтобы синхронизировать");
    }
  }
  return reasons;
}

function printMerge(workspace: Workspace, outcome: MergeOutcome): void {
  for (const name of outcome.merged) console.log(`  слито: ${name}`);
  if (outcome.leaks.length) console.log(`⚠ возможная утечка в заметках слияния: ${outcome.leaks.join(", ")}`);
  if (outcome.stoppedAt) {
    console.log(`конфликт при слиянии ${outcome.stoppedAt}:`);
    for (const c of outcome.conflicts) console.log(`  ${c}`);
    console.log(`Заметки для агента: ${outcome.notesDir}`);
    console.log(`Запустите anonymus (файлы с маркерами уйдут в песочницу «${outcome.target}»), дайте агенту их разрешить,`);
    console.log(`затем: anonymus merge --continue ${outcome.target}`);
  } else {
    console.log(`слияние в «${outcome.target}» завершено. В main: git merge --squash ${workspace.pair(outcome.target).branch}`);
    console.log("Запустите anonymus, чтобы результат синхронизировался в песочницу.");
  }
}

/** Line-by-line mode for non-interactive terminals, logs and CI: all pairs at once. */
async function runHeadless(workspace: Workspace, warnings: string[], strategy?: Strategy): Promise<void> {
  const log = (msg: string, pair?: string) =>
    console.log(`${formatTime(new Date())}  ${pair && workspace.gitEnabled ? `[${pair}] ` : ""}${msg}`);
  for (const w of warnings) log(`⚠ ${w}`);
  const problems = workspace.problems();
  if (problems.length > 0) {
    fail(`небезопасная настройка подпесочниц:\n  - ${problems.join("\n  - ")}`, 1);
  }
  const pairs = workspace.pairs();
  if (pairs.length === 0) {
    fail("подпесочниц нет — создайте: anonymus sandbox new <имя>", 1);
  }

  const running = new Map<string, Syncer>();
  let failed = false;
  const stopAll = (code: number) => {
    log("останавливаюсь…");
    void Promise.all([...running.values()].map((s) => s.stop())).then(() => process.exit(code));
  };

  for (const pair of pairs) {
    const engine = workspace.engineFor(pair.name);
    log(`${pair.projectDir} ⇄ ${pair.sandboxDir}`, pair.name);
    const problem = workspace.check(pair.name, engine.state.size > 0);
    if (problem) {
      log(`✖ ${problem.message} — не запускаю`, pair.name);
      failed = true;
      continue;
    }
    const result = await scan(engine);
    let held = result.statuses.filter(() => false);
    if (!result.clean) {
      if (!strategy) {
        log("проект и песочница расходятся — укажите --strategy project|sandbox|smart|manual или запустите без --no-tui", pair.name);
        failed = true;
        continue;
      }
      const outcome = await applyReconcile(engine, planReconcile(result, strategy));
      held = outcome.held;
      log(`сверка: перенесено ${outcome.transfers.length}, удалено ${outcome.deleted}, слито ${outcome.merged}, на решение ${outcome.held.length}`, pair.name);
    } else {
      await applyReconcile(engine, planReconcile(result, "smart"));
    }
    workspace.markReviewed(pair.name);

    const syncer = new Syncer(engine, held, {
      guard: () => workspace.check(pair.name, engine.state.size > 0),
      gitDir: workspace.gitDirOf(pair.name),
    });
    syncer.on("event", (e) => log(`${e.kind.padEnd(10)} ${e.message}`, pair.name));
    // Nobody to ask what to do: this pair stops, the others go on.
    syncer.once("blocked", () => {
      failed = true;
      running.delete(pair.name);
      void syncer.stop();
      log("пара остановлена — разберитесь и запустите anonymus снова", pair.name);
      if (running.size === 0) stopAll(1);
    });
    running.set(pair.name, syncer);
    await syncer.start();
  }
  if (running.size === 0) {
    stopAll(1);
    return;
  }
  process.on("SIGINT", () => stopAll(failed ? 1 : 0));
  process.on("SIGTERM", () => stopAll(failed ? 1 : 0));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();

  if (args.command === "init") {
    runInit(cwd);
    return;
  }
  const { workspace, warnings } = load(cwd, args.config);

  if (args.command === "scan") {
    await runScan(workspace);
    return;
  }
  if (args.command === "check") {
    runCheck(workspace, args);
    return;
  }
  if (args.command === "sandboxes") {
    printSandboxes(workspace);
    return;
  }

  // One running anonymus per project: it syncs all pairs, and two instances
  // would race on the same folders and sync state.
  const lock = acquireLock(path.join(workspace.config.projectRoot, SERVICE_DIR));
  if ("heldBy" in lock) {
    fail(
      `anonymus уже запущен для этого проекта (процесс ${lock.heldBy}).\n` +
        "Два экземпляра мешали бы друг другу — остановите первый (q) или сделайте это в его интерфейсе.",
      1
    );
  }
  process.on("exit", lock.release);

  if (args.command === "sandbox") {
    await runSandboxCommand(workspace, args.sandboxAction!, args.name!, args);
    return;
  }
  if (args.command === "merge") {
    const target = args.name!;
    try {
      if (args.mergeMode === "abort") {
        abortMerge(workspace, target);
        console.log(`слияние в «${target}» прервано.`);
        return;
      }
      if (args.mergeMode === "continue") {
        const reasons = await settledMap(workspace, [target]);
        printMerge(workspace, continueMerge(workspace, target, (n) => reasons.get(n) ?? null));
        return;
      }
      const sources = args.mergeSources!.length ? args.mergeSources! : defaultMergeSources(workspace, target);
      const reasons = await settledMap(workspace, [target, ...sources]);
      printMerge(workspace, startMerge(workspace, target, sources, (n) => reasons.get(n) ?? null));
    } catch (e) {
      fail(`Ошибка: ${(e as Error).message}`, 1);
    }
    return;
  }
  if (args.command === "commit") {
    const name = args.name!;
    try {
      const message = args.message ?? workspace.defaultCommitMessage(name);
      if (!workspace.commit(name, message)) {
        fail("нечего коммитить — незакоммиченных изменений нет", 1);
      }
      console.log(`закоммичено в ${workspace.pair(name).branch}: ${message}`);
    } catch (e) {
      fail(`Ошибка: ${(e as Error).message}`, 1);
    }
    return;
  }

  if (!args.tui || !process.stdout.isTTY || !process.stdin.isTTY) {
    await runHeadless(workspace, warnings, args.strategy);
    return;
  }
  // Full-screen UI on the alternate screen: resizing redraws one frame instead
  // of leaving copies in the scrollback, and on exit the terminal looks exactly
  // as before the start.
  let onAltScreen = true;
  const leaveAltScreen = () => {
    if (onAltScreen) {
      onAltScreen = false;
      // Mouse reporting off, back to the normal screen; an empty title lets the
      // terminal show its own again.
      process.stdout.write(MOUSE_OFF + "\x1b[?1049l" + terminalTitle(""));
    }
  };
  // Tab title: "🎭 anonymus · <project>" (Windows Terminal shows it as is; VS Code
  // shows it with terminal.integrated.tabs.title set to "${sequence}").
  process.title = "anonymus";
  process.stdout.write(terminalTitle(`🎭 anonymus · ${path.basename(workspace.config.projectRoot)}`));
  // Mouse reporting on: the wheel scrolls the journal instead of acting as ↑ / ↓ (see ui/mouse.ts).
  process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H" + MOUSE_ON);
  process.on("exit", leaveAltScreen);

  const app = render(<App workspace={workspace} version={version()} warnings={warnings} />, {
    stdout: flickerFreeStdout(process.stdout),
    stdin: mouseFilteredStdin(process.stdin),
    exitOnCtrlC: false,
    patchConsole: false,
  });
  await app.waitUntilExit();
  leaveAltScreen();
  console.log(`anonymus остановлен. Журнал: ${path.join(workspace.config.projectRoot, SERVICE_DIR, "anonymus.log")}`);
  process.exit(0);
}

main().catch((e) => fail(`Непредвиденная ошибка: ${(e as Error).stack ?? e}`, 3));
