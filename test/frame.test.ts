import { describe, expect, it } from "vitest";
import { frameToInPlace } from "../src/ui/frameStdout.js";

const ESC = "\x1b[";

describe("frameToInPlace", () => {
  it("drops Ink's erase-all prefix and repaints each line in place", () => {
    const inkFrame = `${ESC}2K${ESC}1A${ESC}2K${ESC}1A${ESC}2K${ESC}Gfirst\nsecond\n`;
    expect(frameToInPlace(inkFrame)).toBe(`${ESC}1;1H${ESC}2Kfirst${ESC}2;1H${ESC}2Ksecond${ESC}J`);
  });

  it("handles the very first frame (nothing to erase yet)", () => {
    expect(frameToInPlace("only\n")).toBe(`${ESC}1;1H${ESC}2Konly${ESC}J`);
  });

  it("never erases all lines before drawing (no blank frame in between)", () => {
    const out = frameToInPlace(`${ESC}2K${ESC}1A${ESC}2K${ESC}Ga\nb\nc\n`);
    expect(out).not.toContain(`${ESC}1A`);
    // Each erase is immediately followed by that line's content.
    expect(out.match(new RegExp(`\\x1b\\[2K[abc]`, "g"))).toHaveLength(3);
  });
});
