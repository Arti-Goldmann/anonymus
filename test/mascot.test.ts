import { describe, expect, it } from "vitest";
import { MASCOT_SPRITE, renderMascot } from "../src/ui/mascot.js";

describe("mascot sprite", () => {
  it("is a rectangle of known palette characters with an even row count", () => {
    expect(MASCOT_SPRITE.length % 2).toBe(0);
    for (const [i, row] of MASCOT_SPRITE.entries()) {
      expect(row.length, `row ${i}`).toBe(MASCOT_SPRITE[0].length);
      expect(row, `row ${i}`).toMatch(/^[.ODWLGK]+$/);
    }
  });

  it("is mirror-symmetric", () => {
    for (const row of MASCOT_SPRITE) {
      expect(row).toBe([...row].reverse().join(""));
    }
  });

  it("renders two pixel rows per terminal line", () => {
    expect(renderMascot()).toHaveLength(MASCOT_SPRITE.length / 2);
  });
});
