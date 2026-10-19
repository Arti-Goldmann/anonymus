// Load test: how long do pairs take to sync with many big files?
//
//   npm run build && node scripts/bench.mjs [files=120] [lines=500] [pairs=3]
//
// Builds a throw-away git project in the temp folder (part of the files in
// Windows-1251 + CRLF, real names sprinkled through the text), creates the
// pairs (branch + worktree + sandbox) and measures:
//   1. first fill of each sandbox (scan + copy);
//   2. a restart with everything in sync (scan only);
//   3. latency of a single edit, sandbox → worktree, live;
//   4. an agent rewriting every file of one sandbox at once;
//   5. agents in all sandboxes rewriting everything at the same time;
//   6. a mass edit on the project side (worktree → sandbox).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = (m) => import(pathToFileURL(path.join(ROOT, "dist", m)).href);
const { Workspace } = await dist("core/workspace.js");
const { scan } = await dist("core/scanner.js");
const { applyReconcile, planReconcile } = await dist("core/reconcile.js");
const { Syncer } = await dist("core/syncer.js");
const { DEFAULT_BINARY } = await dist("config/schema.js");
const iconv = createRequire(path.join(ROOT, "package.json"))("iconv-lite");

const FILES = Number(process.argv[2] ?? 120);
const LINES = Number(process.argv[3] ?? 500);
const PAIRS = Number(process.argv[4] ?? 3);
const DEBOUNCE = 300; // as in the default config

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = () => performance.now();
const secs = (ms) => `${(ms / 1000).toFixed(2)} с`;
const results = [];
const report = (what, ms, extra = "") => {
  results.push([what, secs(ms), extra]);
  console.log(`  ${what.padEnd(52)} ${secs(ms).padStart(9)}  ${extra}`);
};

// --- the project ------------------------------------------------------------
const base = fs.mkdtempSync(path.join(os.tmpdir(), "anonymus-bench-"));
const proj = path.join(base, "proj");
fs.mkdirSync(proj, { recursive: true });

function body(i, variant = "") {
  const out = [];
  for (let l = 0; l < LINES; l++) {
    if (l % 10 === 0) out.push(`// BIGcorpProject module ${i}, line ${l} — ООО Ромашка, https://romashka.ru ${variant}`);
    else if (l % 7 === 0) out.push(`#define BIGCORP_PROJECT_REG_${i}_${l} 0x${(l * 31).toString(16)}`);
    else out.push(`int bigcorp_project_fn_${i}_${l}(int x) { return x * ${l} + ${i}; } /* комментарий ${l} */`);
  }
  return out.join("\n") + "\n";
}
const isWin1251 = (i) => i % 5 === 0; // 20 % of the files: legacy encoding + CRLF
const rel = (i) => `BIGcorpProject_cpu01/mod${String(i % 12).padStart(2, "0")}/file${String(i).padStart(3, "0")}.c`;
function writeProjectFile(dir, i, variant = "") {
  const p = path.join(dir, ...rel(i).split("/"));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const text = body(i, variant);
  fs.writeFileSync(p, isWin1251(i) ? iconv.encode(text.replace(/\n/g, "\r\n"), "win1251") : text);
}

console.log(`проект: ${FILES} файлов × ${LINES} строк, подпесочниц: ${PAIRS}, debounce ${DEBOUNCE} мс`);
let t = t0();
for (let i = 0; i < FILES; i++) writeProjectFile(proj, i);
fs.writeFileSync(path.join(proj, ".gitignore"), "anonymus.yaml\n.anonymus/\n");
const git = (...a) => execFileSync("git", a, { cwd: proj, stdio: ["ignore", "pipe", "pipe"] });
git("init", "--quiet", "--initial-branch=master");
git("config", "user.name", "bench");
git("config", "user.email", "bench@example.com");
git("config", "core.autocrlf", "false");
git("add", "-A");
git("commit", "--quiet", "-m", "init");
const size = (dir) => fs.readdirSync(dir, { recursive: true }).reduce((n, f) => {
  const p = path.join(dir, f);
  return n + (fs.statSync(p).isFile() ? fs.statSync(p).size : 0);
}, 0);
console.log(`  создан за ${secs(t0() - t)}, объём исходников ${(size(path.join(proj, "BIGcorpProject_cpu01")) / 1048576).toFixed(1)} МБ\n`);

const config = {
  projectRoot: proj,
  configPath: path.join(proj, "anonymus.yaml"),
  profile: { name: "default", sandboxRoot: "" },
  sandboxesDir: path.join(base, "sandboxes"),
  worktreesDir: path.join(base, "proj.worktrees"),
  sync: { include: ["**"], exclude: [], binary: DEFAULT_BINARY, encoding: "auto", sandboxEncoding: "keep", poll: false, debounceMs: DEBOUNCE },
  replacements: [
    { real: "BIGcorpProject", placeholder: "MyProject", variants: "auto" },
    { real: "ООО Ромашка", placeholder: "ACME Corp", variants: "exact" },
    { real: "romashka.ru", placeholder: "example.com", variants: "exact" },
  ],
};
const ws = new Workspace(config);
const names = Array.from({ length: PAIRS }, (_, k) => `agent-${k + 1}`);

console.log("1. создание подпесочниц и первое заполнение");
for (const name of names) {
  t = t0();
  ws.create(name, { from: "master" });
  const created = t0() - t;
  t = t0();
  const engine = ws.engineFor(name);
  const result = await scan(engine);
  await applyReconcile(engine, planReconcile(result, "project-wins"));
  engine.flush();
  report(`«${name}»: заполнение песочницы`, t0() - t, `(git worktree add ${secs(created)})`);
}

console.log("\n2. повторный запуск: всё уже совпадает, только скан");
for (const name of names) {
  t = t0();
  const result = await scan(ws.engineFor(name));
  report(`«${name}»: скан`, t0() - t, result.clean ? "совпадают" : "РАСХОДЯТСЯ!");
}

// --- live --------------------------------------------------------------------
const syncers = [];
for (const name of names) {
  const engine = ws.engineFor(name);
  const s = new Syncer(engine, [], { guard: () => ws.check(name, engine.state.size > 0), gitDir: ws.gitDirOf(name) });
  s.on("blocked", (p) => console.log(`  ✖ ${name}: ${p.message}`));
  s.on("event", (e) => {
    if (e.kind === "to-project" || e.kind === "to-sandbox") transfers++;
  });
  await s.start();
  syncers.push(s);
}
await sleep(1500); // the initial rescan of the watchers settles

const sbFile = (name, i) => path.join(ws.pair(name).sandboxDir, ...rel(i).replace(/BIGcorpProject/g, "MyProject").split("/"));
const wtFile = (name, i) => path.join(ws.pair(name).projectDir, ...rel(i).split("/"));
const readAny = (p) => {
  try {
    const b = fs.readFileSync(p);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(b);
    } catch {
      return iconv.decode(b, "win1251");
    }
  } catch {
    return "";
  }
};
/** Rewrite a sandbox file the way an agent would (placeholders, same encoding). */
function agentWrite(name, i, mark) {
  const text = body(i, mark).replace(/BIGcorpProject/g, "MyProject").replace(/BIGCORP_PROJECT/g, "MY_PROJECT")
    .replace(/bigcorp_project/g, "my_project").replace(/ООО Ромашка/g, "ACME Corp").replace(/romashka\.ru/g, "example.com");
  fs.writeFileSync(sbFile(name, i), isWin1251(i) ? iconv.encode(text.replace(/\n/g, "\r\n"), "win1251") : text);
}
/**
 * Time until every file arrived. Completion is taken from the syncers'
 * transfer events (polling hundreds of files would itself slow the syncers
 * down — same process, same disk); the files are checked once at the end.
 */
let transfers = 0;
async function waitAll(files, mark, start = t0(), timeoutMs = 600_000) {
  const target = transfers + files.length;
  while (transfers < target) {
    if (t0() - start > timeoutMs) throw new Error(`не дождался ${target - transfers} файлов`);
    await sleep(20);
  }
  const took = t0() - start;
  const missing = files.filter((f) => !readAny(f).includes(mark));
  if (missing.length) throw new Error(`${missing.length} файлов без правки, например ${missing[0]}`);
  return took;
}
const idle = async () => {
  while (!syncers.every((s) => s.isIdle())) await sleep(50);
};

console.log("\n3. одна правка агента: песочница → worktree (живая синхронизация)");
const lat = [];
for (let k = 0; k < 5; k++) {
  const mark = `single-${k}`;
  t = t0();
  agentWrite(names[0], k * 7, mark);
  await waitAll([wtFile(names[0], k * 7)], mark, t);
  lat.push(t0() - t);
  await idle();
}
lat.sort((a, b) => a - b);
report("задержка одной правки (медиана из 5)", lat[2], `мин ${secs(lat[0])}, макс ${secs(lat[4])}`);

console.log(`\n4. агент переписал все ${FILES} файлов своей песочницы разом`);
t = t0();
for (let i = 0; i < FILES; i++) agentWrite(names[0], i, "burst1");
report(`«${names[0]}»: ${FILES} файлов в worktree`, await waitAll(Array.from({ length: FILES }, (_, i) => wtFile(names[0], i)), "burst1", t), "от первой записи до последнего файла");
await idle();

console.log(`\n5. все ${PAIRS} агента переписали всё одновременно (${FILES * PAIRS} файлов)`);
t = t0();
for (let i = 0; i < FILES; i++) for (const name of names) agentWrite(name, i, "burstAll");
const all = [];
for (const name of names) for (let i = 0; i < FILES; i++) all.push(wtFile(name, i));
report(`${FILES * PAIRS} файлов в ${PAIRS} worktree`, await waitAll(all, "burstAll", t), "параллельно, от начала записи");
await idle();

console.log(`\n6. разработчик изменил все ${FILES} файлов в worktree «${names[0]}» (worktree → песочница)`);
t = t0();
for (let i = 0; i < FILES; i++) writeProjectFile(ws.pair(names[0]).projectDir, i, "dev");
report(`«${names[0]}»: ${FILES} файлов в песочнице`, await waitAll(Array.from({ length: FILES }, (_, i) => sbFile(names[0], i)), "dev", t), "");
await idle();

// Correctness after all that: every pair in sync, encodings kept, no real names in sandboxes.
console.log("\nпроверка после нагрузки");
for (const s of syncers) await s.stop();
let leaks = 0;
for (const name of names) {
  const result = await scan(ws.engineFor(name));
  for (let i = 0; i < FILES; i++) if (/BIGcorp|Ромашка|romashka/i.test(readAny(sbFile(name, i)))) leaks++;
  const crlf = fs.readFileSync(wtFile(name, 0)).includes(Buffer.from("\r\n"));
  console.log(`  «${name}»: ${result.clean ? "совпадают" : "РАСХОДЯТСЯ"}, win1251+CRLF сохранены: ${crlf ? "да" : "НЕТ"}`);
}
console.log(`  реальных имён в песочницах: ${leaks}`);
console.log(`  память процесса: ${(process.memoryUsage().rss / 1048576).toFixed(0)} МБ`);

fs.rmSync(base, { recursive: true, force: true });
process.exit(0);
