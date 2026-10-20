import * as fs from "node:fs";
import * as path from "node:path";
import yaml from "js-yaml";
import type { EncodingSetting } from "../core/encoding.js";
import {
  AnonymusConfig,
  CONFIG_FILENAMES,
  DEFAULT_BINARY,
  ReplacementRule,
  SERVICE_DIR,
  SyncRules,
} from "./schema.js";
import {
  preprocessMultilineScalars,
  normalizeMultilineValue,
} from "./multiline.js";

/** Config cannot be used: the messages explain every problem found. */
export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join("\n"));
    this.name = "ConfigError";
  }
}

export interface LoadResult {
  config: AnonymusConfig;
  warnings: string[];
}

/**
 * Locate the config: an explicit path wins, otherwise `anonymus.yaml` (or
 * `.anonymus.yaml`) in `cwd`. The tool is always started from the project
 * root, so parent directories are deliberately not searched.
 */
export function findConfig(cwd: string, explicit?: string): string {
  if (explicit) {
    const p = path.resolve(cwd, explicit);
    if (!fs.existsSync(p)) {
      throw new ConfigError([`Конфиг не найден: ${p}`]);
    }
    return p;
  }
  for (const name of CONFIG_FILENAMES) {
    const p = path.join(cwd, name);
    if (fs.existsSync(p)) {
      return p;
    }
  }
  throw new ConfigError([
    `В ${cwd} нет ${CONFIG_FILENAMES[0]}.`,
    "Запустите `anonymus init`, чтобы создать его из шаблона.",
  ]);
}

function stringList(value: unknown, field: string, problems: string[]): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    problems.push(`${field}: ожидается список строк.`);
    return [];
  }
  return value.map((v) => String(v).trim()).filter((v) => v.length > 0);
}

function parseEncoding(value: unknown, problems: string[]): EncodingSetting {
  if (value === undefined || value === null) {
    return "auto";
  }
  if (value === "auto" || value === "utf8" || value === "win1251") {
    return value;
  }
  problems.push(`sync.encoding: допустимо auto | utf8 | win1251, указано "${String(value)}".`);
  return "auto";
}

function parseSync(raw: any, problems: string[], warnings: string[]): SyncRules {
  const s = raw?.sync;
  if (!s || typeof s !== "object") {
    problems.push("Нет секции `sync` (нужен как минимум sync.include).");
  }
  const include = stringList(s?.include, "sync.include", problems);
  if (s && include.length === 0) {
    problems.push(
      "sync.include пуст: перечислите явно, что синхронизировать (\"**\" — весь проект)."
    );
  }
  const userBinary = stringList(s?.binary, "sync.binary", problems);

  let debounceMs = 300;
  if (s?.debounce_ms !== undefined) {
    if (typeof s.debounce_ms === "number" && s.debounce_ms >= 0) {
      debounceMs = s.debounce_ms;
    } else {
      problems.push("sync.debounce_ms: ожидается неотрицательное число.");
    }
  }
  if (s?.poll !== undefined && typeof s.poll !== "boolean") {
    warnings.push("sync.poll: ожидается true/false, использую false.");
  }
  const sandboxEncoding = s?.sandbox_encoding ?? "keep";
  if (sandboxEncoding !== "keep" && sandboxEncoding !== "utf8") {
    problems.push(`sync.sandbox_encoding: допустимо keep | utf8, указано "${String(sandboxEncoding)}".`);
  }

  return {
    include,
    exclude: stringList(s?.exclude, "sync.exclude", problems),
    // User binary patterns extend the defaults: dropping e.g. `*.png` by
    // accident would run images through text replacement and corrupt them.
    binary: [...DEFAULT_BINARY, ...userBinary],
    encoding: parseEncoding(s?.encoding, problems),
    sandboxEncoding: sandboxEncoding === "utf8" ? "utf8" : "keep",
    poll: s?.poll === true,
    debounceMs,
  };
}

function parseReplacements(raw: any, problems: string[], warnings: string[]): ReplacementRule[] {
  const list = raw?.replacements;
  if (list === undefined || list === null) {
    warnings.push("Нет списка replacements — файлы будут копироваться без анонимизации.");
    return [];
  }
  if (!Array.isArray(list)) {
    problems.push("replacements: ожидается список.");
    return [];
  }
  const rules: ReplacementRule[] = [];
  for (const [i, item] of list.entries()) {
    if (!item || typeof item.real !== "string" || typeof item.placeholder !== "string") {
      problems.push(`replacements[${i}]: нужны строковые поля real и placeholder.`);
      continue;
    }
    const real = normalizeMultilineValue(item.real);
    const placeholder = normalizeMultilineValue(item.placeholder);
    if (real.length === 0 || placeholder.length === 0) {
      problems.push(`replacements[${i}]: real и placeholder не могут быть пустыми.`);
      continue;
    }
    rules.push({
      real,
      placeholder,
      variants: item.variants === "exact" ? "exact" : "auto",
      description: typeof item.description === "string" ? item.description : undefined,
    });
  }

  // A placeholder that equals some real value makes the mapping ambiguous:
  // deanonymizing would turn unrelated text into a real name.
  const reals = new Set(rules.map((r) => r.real.toLowerCase()));
  for (const r of rules) {
    if (reals.has(r.placeholder.toLowerCase())) {
      problems.push(
        `replacements: плейсхолдер "${r.placeholder}" совпадает с реальным значением другой замены — замена необратима.`
      );
    }
  }
  const seen = new Map<string, string>();
  for (const r of rules) {
    const key = r.placeholder.toLowerCase();
    const prev = seen.get(key);
    if (prev !== undefined && prev !== r.real) {
      problems.push(
        `replacements: плейсхолдер "${r.placeholder}" используется для "${prev}" и "${r.real}" — обратная замена неоднозначна.`
      );
    }
    seen.set(key, r.real);
  }
  return rules;
}

/** True if `child` is `parent` itself or lies somewhere inside it. */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Read, parse and validate a config file. Throws ConfigError on problems. */
export function loadConfig(configPath: string): LoadResult {
  const problems: string[] = [];
  const warnings: string[] = [];
  const projectRoot = path.dirname(path.resolve(configPath));

  let raw: any;
  try {
    // Allow pasting multi-line text verbatim into quoted values.
    const text = preprocessMultilineScalars(fs.readFileSync(configPath, "utf8"));
    raw = yaml.load(text);
  } catch (e) {
    throw new ConfigError([`Не удалось разобрать ${configPath}: ${(e as Error).message}`]);
  }
  if (!raw || typeof raw !== "object") {
    throw new ConfigError([`${configPath} пуст или не является YAML-словарём.`]);
  }
  if (raw.version !== undefined && raw.version !== 1) {
    problems.push(`version: поддерживается только 1, указано ${String(raw.version)}.`);
  }

  let sandboxRoot = "";
  if (raw.sandbox === undefined && typeof raw.sandboxes_dir === "string") {
    // Git projects may set only sandboxes_dir: every sandbox is a sub-sandbox there.
  } else if (typeof raw.sandbox !== "string" || raw.sandbox.trim() === "") {
    problems.push(
      "sandbox: укажите путь к папке песочницы (относительно проекта или абсолютный) или sandboxes_dir."
    );
  } else {
    sandboxRoot = path.resolve(projectRoot, raw.sandbox.trim());
    if (isInside(sandboxRoot, projectRoot) || isInside(projectRoot, sandboxRoot)) {
      problems.push(
        `sandbox: песочница (${sandboxRoot}) не может лежать внутри проекта или содержать его — синхронизация зациклится.`
      );
    } else if (!fs.existsSync(sandboxRoot)) {
      warnings.push(`Папка песочницы ${sandboxRoot} не существует — она будет создана при заполнении.`);
    }
  }

  // Where new sub-sandboxes go: next to the default sandbox unless configured.
  let sandboxesDir = sandboxRoot ? path.dirname(sandboxRoot) : "";
  if (raw.sandboxes_dir !== undefined) {
    if (typeof raw.sandboxes_dir !== "string" || raw.sandboxes_dir.trim() === "") {
      problems.push("sandboxes_dir: ожидается путь к папке.");
    } else {
      sandboxesDir = path.resolve(projectRoot, raw.sandboxes_dir.trim());
      if (isInside(sandboxesDir, projectRoot)) {
        problems.push(`sandboxes_dir: папка подпесочниц (${sandboxesDir}) не может лежать внутри проекта.`);
      }
    }
  }

  // Git worktrees of the sub-sandboxes: next to the project by default. A
  // folder inside the project (e.g. `.worktrees`) is allowed too — the main
  // folder is never synced, and anonymus hides it from git (.git/info/exclude);
  // tools that scan the project recursively will see the copies, though.
  let worktreesDir = path.join(path.dirname(projectRoot), `${path.basename(projectRoot)}.worktrees`);
  if (raw.worktrees_dir !== undefined) {
    if (typeof raw.worktrees_dir !== "string" || raw.worktrees_dir.trim() === "") {
      problems.push("worktrees_dir: ожидается путь к папке.");
    } else {
      worktreesDir = path.resolve(projectRoot, raw.worktrees_dir.trim());
    }
  }
  if (isInside(projectRoot, worktreesDir)) {
    problems.push(`worktrees_dir: папка worktree (${worktreesDir}) не может быть папкой проекта или содержать её.`);
  } else if (isInside(worktreesDir, path.join(projectRoot, SERVICE_DIR)) || isInside(worktreesDir, path.join(projectRoot, ".git"))) {
    problems.push(`worktrees_dir: ${worktreesDir} — служебная папка, выберите другую (например, .worktrees).`);
  }
  // Sandboxes must never end up inside the worktrees (or a worktree inside a
  // sandbox). Worktrees next to the sandboxes in one parent folder are fine.
  const clash = (label: string, dir: string, both: boolean) => {
    if (dir && (isInside(dir, worktreesDir) || (both && isInside(worktreesDir, dir)))) {
      problems.push(
        `${label}: ${dir} и папка worktree ${worktreesDir} не могут лежать одна в другой — ` +
          "песочницы и рабочие копии проекта должны быть раздельно."
      );
    }
  };
  clash("sandboxes_dir", sandboxesDir, false);
  clash("sandbox", sandboxRoot, true);

  const sync = parseSync(raw, problems, warnings);
  const replacements = parseReplacements(raw, problems, warnings);

  if (problems.length > 0) {
    throw new ConfigError(problems);
  }

  return {
    config: {
      projectRoot,
      configPath: path.resolve(configPath),
      profile: { name: "default", sandboxRoot },
      sandboxesDir,
      worktreesDir,
      sync,
      replacements,
    },
    warnings,
  };
}
