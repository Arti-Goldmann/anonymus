import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { filterMouse, mouseBus, mouseFilteredStdin } from "../src/ui/mouse.js";

const WHEEL_UP = "\x1b[<64;10;5M";
const WHEEL_DOWN = "\x1b[<65;10;5M";
const CLICK = "\x1b[<0;10;5M\x1b[<0;10;5m";

describe("mouse wheel", () => {
  afterEach(() => mouseBus.removeAllListeners());

  it("sends the wheel to a listener and keeps the arrow keys for Ink", () => {
    const seen: number[] = [];
    mouseBus.on("wheel", (d) => seen.push(d));
    expect(filterMouse(`${WHEEL_UP}\x1b[A${WHEEL_DOWN}${WHEEL_DOWN}q`)).toBe("\x1b[Aq");
    expect(seen).toEqual([-1, 1, 1]);
  });

  it("turns the wheel into arrows when nobody listens; clicks never reach Ink", () => {
    expect(filterMouse(`${WHEEL_UP}${WHEEL_DOWN}`)).toBe("\x1b[A\x1b[B");
    expect(filterMouse(`${CLICK}x`)).toBe("x");
  });

  it("reports a left click once, at 0-based cells", () => {
    const clicks: { x: number; y: number }[] = [];
    mouseBus.on("click", (c) => clicks.push(c));
    filterMouse(CLICK); // press + release
    expect(clicks).toEqual([{ x: 9, y: 4 }]);
  });

  it("joins a mouse sequence split across two chunks; a lone Escape passes", async () => {
    const source = Object.assign(new PassThrough(), { setRawMode: () => {}, ref: () => {}, unref: () => {} });
    const stdin = mouseFilteredStdin(source);
    let received = "";
    stdin.on("data", (d: Buffer) => (received += d.toString()));
    const seen: number[] = [];
    mouseBus.on("wheel", (d) => seen.push(d));

    source.write("\x1b[<64;1");
    source.write(";2M");
    source.write("\x1b");
    await new Promise((r) => setImmediate(r));
    expect(seen).toEqual([-1]);
    expect(received).toBe("\x1b");
  });
});
