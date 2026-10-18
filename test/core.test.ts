import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import iconv from "iconv-lite";
import { SyncFilter } from "../src/core/filter.js";
import { Transformer } from "../src/core/transformer.js";
import { PathMapper } from "../src/core/paths.js";
import { diff3Text } from "../src/core/merge.js";
import { ConfigError, loadConfig } from "../src/config/loader.js";
import { makeBench, REPLACEMENTS, type Bench } from "./helpers.js";

describe("SyncFilter (.gitignore semantics)", () => {
  const f = new SyncFilter({
    include: ["**"],
    exclude: [".venv*", "/build", "src/gen/tmp.c", ".cache"],
    binary: ["*.png"],
  });

  it("prefix pattern excludes all derivatives at any depth", () => {
    expect(f.isSynced(".venv/lib/a.py")).toBe(false);
    expect(f.isSynced(".venv-ubuntu/lib/a.py")).toBe(false);
    expect(f.isSynced("tools/.venv2/x.py")).toBe(false);
    expect(f.isDirExcluded(".venv-ubuntu")).toBe(true);
  });

  it("exact name pattern does not catch derivatives", () => {
    expect(f.isSynced(".cache/a.txt")).toBe(false);
    expect(f.isSynced(".cache-old/a.txt")).toBe(true);
  });

  it("leading slash anchors to the project root", () => {
    expect(f.isSynced("build/out.c")).toBe(false);
    expect(f.isSynced("src/build/out.c")).toBe(true);
  });

  it("exact file path excludes only that file", () => {
    expect(f.isSynced("src/gen/tmp.c")).toBe(false);
    expect(f.isSynced("src/gen/tmp2.c")).toBe(true);
  });

  it("include restricts what is synced; .git and .anonymus are never synced", () => {
    const g = new SyncFilter({ include: ["/src/", "CMakeLists.txt"], exclude: [], binary: [] });
    expect(g.isSynced("src/a.c")).toBe(true);
    expect(g.isSynced("lib/CMakeLists.txt")).toBe(true);
    expect(g.isSynced("docs/readme.md")).toBe(false);
    expect(new SyncFilter({ include: ["**"], exclude: [], binary: [] }).isSynced(".git/config")).toBe(false);
    expect(new SyncFilter({ include: ["**"], exclude: [], binary: [] }).isSynced(".anonymus/x")).toBe(false);
  });

  it("detects binaries", () => {
    expect(f.isBinary("img/logo.png")).toBe(true);
    expect(f.isBinary("src/a.c")).toBe(false);
  });
});

describe("paths and transformer", () => {
  const t = new Transformer(REPLACEMENTS);
  const m = new PathMapper(t);

  it("maps folder names through placeholders and back", () => {
    expect(m.toSandbox("BIGcorpProject_cpu01/main.c")).toBe("MyProject_cpu01/main.c");
    expect(m.toCanonical("MyProject_cpu01/main.c")).toBe("BIGcorpProject_cpu01/main.c");
    expect(m.projectPathProblem("BIGcorpProject_cpu01/main.c")).toBeUndefined();
  });

  it("handles a stylized name like BIGcorpProject in every casing, both ways", () => {
    const src = [
      "BIGcorpProject_cpu01",
      '#include "bigcorp_project.h"',
      "int BIGCORP_PROJECT_VERSION;",
      "bigcorpProject bigcorp-project bigcorpproject",
    ].join("\n");
    const anon = t.anonymize(src).text;
    expect(anon).toBe(
      ["MyProject_cpu01", '#include "my_project.h"', "int MY_PROJECT_VERSION;", "myProject my-project myproject"].join("\n")
    );
    expect(t.deanonymize(anon).text).toBe(src);
    expect(t.findLeaks(anon)).toEqual([]);
    expect(t.findLeaks("// Bigcorp Project team")).toContain("BIGcorpProject");
  });

  it("flags a project path that would collide with a placeholder path", () => {
    expect(m.projectPathProblem("MyProject_cpu01/main.c")).toBeDefined();
  });

  it("flags a sandbox path that still contains a real name", () => {
    expect(m.sandboxPathProblem("BIGcorpProject/x.c")).toBeDefined();
    expect(m.sandboxPathProblem("MyProject/x.c")).toBeUndefined();
  });

  it("round-trips content with case variants and finds leaks", () => {
    const t2 = new Transformer([
      { real: "RomashkaSoft", placeholder: "AcmeCorp", variants: "auto" },
      { real: "romashka.ru", placeholder: "example.com", variants: "exact" },
    ]);
    const src = "RomashkaSoft romashka_soft ROMASHKA_SOFT romashkaSoft https://romashka.ru";
    const anon = t2.anonymize(src).text;
    expect(anon).toBe("AcmeCorp acme_corp ACME_CORP acmeCorp https://example.com");
    expect(t2.deanonymize(anon).text).toBe(src);
    expect(t2.findLeaks(anon)).toEqual([]);
    expect(t2.findLeaks("ROMASHKA.RU")).toContain("romashka.ru");
  });
});

describe("diff3Text", () => {
  it("merges non-overlapping edits and keeps conflicts marked", () => {
    const base = "a\nb\nc\n";
    expect(diff3Text("A\nb\nc\n", base, "a\nb\nC\n")).toEqual({ text: "A\nb\nC\n", conflict: false });
    const r = diff3Text("a\nX\nc\n", base, "a\nY\nc\n");
    expect(r.conflict).toBe(true);
    expect(r.text).toContain("<<<<<<< проект");
  });

  it("ignores EOL differences between sides", () => {
    expect(diff3Text("A\r\nb\r\nc\r\n", "a\nb\nc\n", "a\nb\nC\n")).toEqual({ text: "A\nb\nC\n", conflict: false });
  });
});

describe("config loader", () => {
  let bench: Bench;
  afterEach(() => bench?.cleanup());

  it("loads a valid config with a multi-line value", () => {
    bench = makeBench();
    bench.write(
      "project",
      "anonymus.yaml",
      [
        "sandbox: ../sandbox",
        "sync:",
        "  include: ['**']",
        "  exclude: ['.venv*']",
        "replacements:",
        '  - real: "Line one',
        'line two"',
        "    placeholder: Txt",
      ].join("\n")
    );
    const { config } = loadConfig(path.join(bench.project, "anonymus.yaml"));
    expect(config.profile.sandboxRoot).toBe(bench.sandbox);
    expect(config.replacements[0].real).toBe("Line one\nline two");
    expect(config.sync.exclude).toEqual([".venv*"]);
  });

  it("rejects missing include and a sandbox inside the project", () => {
    bench = makeBench();
    bench.write("project", "anonymus.yaml", "sandbox: ./inner\nsync:\n  exclude: []\n");
    expect(() => loadConfig(path.join(bench.project, "anonymus.yaml"))).toThrow(ConfigError);
    try {
      loadConfig(path.join(bench.project, "anonymus.yaml"));
    } catch (e) {
      const problems = (e as ConfigError).problems.join("\n");
      expect(problems).toContain("sync.include");
      expect(problems).toContain("внутри проекта");
    }
  });
});

describe("SyncEngine", () => {
  let bench: Bench;
  afterEach(() => bench?.cleanup());

  it("copies win1251 project file to sandbox keeping encoding and CRLF", () => {
    bench = makeBench();
    bench.writeWin1251("project", "BIGcorpProject_cpu01/main.c", "// Комментарий BIGcorpProject\r\nint x;\r\n");
    const e = bench.engine();
    expect(e.classify("BIGcorpProject_cpu01/main.c").kind).toBe("only-project");
    const r = e.copy("project", "BIGcorpProject_cpu01/main.c");
    expect(r.replacements).toBe(1);
    const bytes = bench.readBytes("sandbox", "MyProject_cpu01/main.c")!;
    expect(iconv.decode(bytes, "win1251")).toBe("// Комментарий MyProject\r\nint x;\r\n");
    expect(e.classify("BIGcorpProject_cpu01/main.c").kind).toBe("synced");
  });

  it("writes back into the project's own encoding and EOL style", () => {
    bench = makeBench();
    bench.writeWin1251("project", "a.c", "// Привет BIGcorpProject\r\nold\r\n");
    const e = bench.engine({ sandboxEncoding: "utf8" });
    e.copy("project", "a.c");
    expect(bench.read("sandbox", "a.c")).toBe("// Привет MyProject\r\nold\r\n");
    // Agent rewrites the file in UTF-8 with LF.
    bench.write("sandbox", "a.c", "// Привет MyProject\nnew\n");
    expect(e.classify("a.c").kind).toBe("sandbox-changed");
    e.copy("sandbox", "a.c");
    expect(iconv.decode(bench.readBytes("project", "a.c")!, "win1251")).toBe("// Привет BIGcorpProject\r\nnew\r\n");
    expect(e.classify("a.c").kind).toBe("synced");
  });

  it("treats LF/CRLF-only differences as in sync", () => {
    bench = makeBench();
    bench.write("project", "u.py", "x = 1\r\ny = 2\r\n");
    bench.write("sandbox", "u.py", "x = 1\ny = 2\n");
    expect(bench.engine().classify("u.py").kind).toBe("synced");
  });

  it("detects one-sided changes, deletions and both-sided changes", () => {
    bench = makeBench();
    bench.write("project", "f.txt", "BIGcorpProject\n");
    const e = bench.engine();
    e.copy("project", "f.txt");

    bench.write("project", "f.txt", "BIGcorpProject v2\n");
    expect(e.classify("f.txt").kind).toBe("project-changed");
    bench.write("sandbox", "f.txt", "MyProject v3\n");
    expect(e.classify("f.txt").kind).toBe("both-changed");

    e.copy("project", "f.txt");
    bench.remove("sandbox", "f.txt");
    expect(e.classify("f.txt").kind).toBe("deleted-in-sandbox");
    e.remove("project", "f.txt");
    expect(bench.exists("project", "f.txt")).toBe(false);
    const trashed = fs.readdirSync(e.trash.sessionDir, { recursive: true }).map(String);
    expect(trashed.some((p) => p.endsWith("f.txt"))).toBe(true);
  });

  it("auto-merges edits made on both sides in different lines", () => {
    bench = makeBench();
    bench.write("project", "m.c", "BIGcorpProject\nline2\nline3\nline4\n");
    const e = bench.engine();
    e.copy("project", "m.c");
    bench.write("project", "m.c", "BIGcorpProject\nline2 project\nline3\nline4\n");
    bench.write("sandbox", "m.c", "MyProject\nline2\nline3\nline4 sandbox\n");
    expect(e.autoMerge("m.c").ok).toBe(true);
    expect(bench.read("project", "m.c")).toBe("BIGcorpProject\nline2 project\nline3\nline4 sandbox\n");
    expect(bench.read("sandbox", "m.c")).toBe("MyProject\nline2 project\nline3\nline4 sandbox\n");
    expect(e.classify("m.c").kind).toBe("synced");
  });

  it("keeps binaries byte-identical", () => {
    bench = makeBench();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x42, 0x49, 0x47]);
    bench.write("project", "BIGcorpProject/logo.png", png);
    const e = bench.engine();
    e.copy("project", "BIGcorpProject/logo.png");
    expect(bench.readBytes("sandbox", "MyProject/logo.png")!.equals(png)).toBe(true);
  });
});
