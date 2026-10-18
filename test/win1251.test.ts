import { afterEach, describe, expect, it } from "vitest";
import iconv from "iconv-lite";
import { Syncer } from "../src/core/syncer.js";
import { makeBench, type Bench } from "./helpers.js";

const FILE = "BIGcorpProject_cpu01/main.c";
const SB_FILE = "MyProject_cpu01/main.c";

const ORIGINAL = [
  "// Прошивка BIGcorpProject для заказчика",
  "int main(void)",
  "{",
  "    uart_init(BIGCORP_PROJECT_BAUDRATE);",
  "    // основной цикл",
  "    while (1) { }",
  "}",
  "",
].join("\r\n");

const isUtf8 = (b: Buffer) => {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(b);
    return true;
  } catch {
    return false;
  }
};

async function waitFor(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("conflicts in Windows-1251 files", () => {
  let bench: Bench;
  let syncer: Syncer | null = null;
  afterEach(async () => {
    await syncer?.stop();
    syncer = null;
    bench?.cleanup();
  });

  const project = () => iconv.decode(bench.readBytes("project", FILE)!, "win1251");
  const sandbox = () => iconv.decode(bench.readBytes("sandbox", SB_FILE)!, "win1251");

  function synced() {
    bench = makeBench();
    bench.writeWin1251("project", FILE, ORIGINAL);
    const e = bench.engine();
    e.copy("project", FILE);
    e.flush();
    return e;
  }

  it("auto-merges edits in different lines, keeping win1251, Cyrillic and CRLF", () => {
    const e = synced();
    bench.writeWin1251("project", FILE, ORIGINAL.replace("// основной цикл", "// основной цикл, ревизия Б"));
    bench.writeWin1251("sandbox", SB_FILE, sandbox().replace("// Прошивка MyProject", "// Прошивка MyProject (новая)"));

    expect(e.classify(FILE).kind).toBe("both-changed");
    expect(e.autoMerge(FILE).ok).toBe(true);

    const p = bench.readBytes("project", FILE)!;
    expect(isUtf8(p)).toBe(false); // still win1251 on disk
    expect(project()).toBe(
      ORIGINAL.replace("// основной цикл", "// основной цикл, ревизия Б").replace(
        "// Прошивка BIGcorpProject",
        "// Прошивка BIGcorpProject (новая)"
      )
    );
    expect(sandbox()).toContain("// Прошивка MyProject (новая) для заказчика\r\n");
    expect(sandbox()).toContain("// основной цикл, ревизия Б\r\n");
    expect(e.classify(FILE).kind).toBe("synced");
  });

  it("holds a same-line conflict and resolves it to either side in win1251", async () => {
    const e = synced();
    syncer = new Syncer(e);
    await syncer.start();

    bench.writeWin1251("project", FILE, ORIGINAL.replace("uart_init(BIGCORP_PROJECT_BAUDRATE);", "uart_init(9600); // проект"));
    bench.writeWin1251("sandbox", SB_FILE, sandbox().replace("uart_init(MY_PROJECT_BAUDRATE);", "uart_init(MY_PROJECT_BAUDRATE * 2); // агент"));
    await waitFor(() => syncer!.getHeld().length === 1);
    // Held: nothing was overwritten.
    expect(project()).toContain("uart_init(9600); // проект");
    expect(sandbox()).toContain("uart_init(MY_PROJECT_BAUDRATE * 2); // агент");

    const r = await syncer.resolve(FILE, "sandbox");
    expect(r.ok).toBe(true);
    expect(isUtf8(bench.readBytes("project", FILE)!)).toBe(false);
    expect(project()).toContain("    uart_init(BIGCORP_PROJECT_BAUDRATE * 2); // агент\r\n");
    expect(project()).toContain("// Прошивка BIGcorpProject для заказчика\r\n");
    expect(syncer.getHeld()).toHaveLength(0);
  });

  it("applies a manual (editor) resolution with Cyrillic to both sides", () => {
    const e = synced();
    bench.writeWin1251("project", FILE, ORIGINAL.replace("uart_init(BIGCORP_PROJECT_BAUDRATE);", "uart_init(9600);"));
    bench.writeWin1251("sandbox", SB_FILE, sandbox().replace("uart_init(MY_PROJECT_BAUDRATE);", "uart_init(1);"));
    expect(e.autoMerge(FILE).ok).toBe(false);

    // What the user saved in the merge editor (project form, LF, as VS Code writes it).
    const resolved = ORIGINAL.replace("uart_init(BIGCORP_PROJECT_BAUDRATE);", "uart_init(19200); // решено вручную").replace(/\r\n/g, "\n");
    const result = e.writeResolved(FILE, resolved);
    expect(result.warnings).toEqual([]);
    expect(project()).toBe(ORIGINAL.replace("uart_init(BIGCORP_PROJECT_BAUDRATE);", "uart_init(19200); // решено вручную"));
    expect(sandbox()).toContain("uart_init(19200); // решено вручную\r\n");
    expect(sandbox()).toContain("// Прошивка MyProject для заказчика");
    expect(e.classify(FILE).kind).toBe("synced");
  });

  it("merges when the agent re-saved the win1251 file as UTF-8", () => {
    const e = synced();
    bench.writeWin1251("project", FILE, ORIGINAL.replace("для заказчика", "для заказчика, v2"));
    // Agent's editor saved the sandbox copy in UTF-8 with LF.
    bench.write("sandbox", SB_FILE, sandbox().replace("while (1) { }", "while (1) { tick(); }").replace(/\r\n/g, "\n"));

    expect(e.autoMerge(FILE).ok).toBe(true);
    expect(isUtf8(bench.readBytes("project", FILE)!)).toBe(false); // project stays win1251
    expect(project()).toContain("// Прошивка BIGcorpProject для заказчика, v2\r\n");
    expect(project()).toContain("while (1) { tick(); }\r\n");
  });
});
