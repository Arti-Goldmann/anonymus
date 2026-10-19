import chalk from "chalk";

/**
 * The anonymus mascot: an orange space invader wearing a Guy Fawkes mask,
 * drawn small (24×14) — exactly as tall as the info lines next to it in the header
 * (14 pixel rows = 7 terminal rows) — and mirror-symmetric: arched brows,
 * slanted eyes, cheek lines, the upturned moustache and the goatee.
 * One character per pixel; two pixel rows are packed into one terminal row
 * with the half-block glyphs ▀ / ▄ (foreground = one pixel, background = the
 * other), so the sprite keeps square-ish proportions.
 *
 *   .  transparent      O  orange body       D  body shadow
 *   W  mask             L  light shading     G  mid shading
 *   K  outline / features
 */
export const MASCOT_SPRITE: readonly string[] = [
  "...OOKKKKKKKKKKKKKKOO...",
  "...OKLWWWWWWWWWWWWLKO...",
  "...OKKKKKLWWWWLKKKKKO...",
  "...OKLWKKKWWWWKKKWLKO...",
  "...OKWWWKKWLLWKKWWWKO...",
  "...OKWKKWWWLLWWWKKWKO...",
  "OOOKWWWLLWWWWWWLLWWWKOOO",
  "OOOKWWKWWKKKKKKWWKWWKOOO",
  "OOOKWWKKKKKKKKKKKKWWKOOO",
  "OOODKWWKKKKWWKKKKWWKDOOO",
  "...ODKLWWWWKKWWWWLKDO...",
  "...OODKKWWWKKWWWKKDOO...",
  "...OOOODKKKKKKKKDOOOO...",
  "....D.D..........D.D....",
];

const PALETTE: Record<string, string> = {
  O: "#EC6A43",
  D: "#D16040",
  W: "#F3ECE2",
  L: "#CEC7BD",
  G: "#AAA6A0",
  K: "#1C1B1C",
};

/** Render the sprite to ANSI lines (empty strings if colors are unsupported). */
export function renderMascot(sprite: readonly string[] = MASCOT_SPRITE): string[] {
  const lines: string[] = [];
  for (let y = 0; y < sprite.length; y += 2) {
    const top = sprite[y];
    const bottom = sprite[y + 1] ?? "";
    let line = "";
    for (let x = 0; x < top.length; x++) {
      const t = PALETTE[top[x]];
      const b = PALETTE[bottom[x] ?? "."];
      if (t && b) {
        line += chalk.hex(t).bgHex(b)("▀");
      } else if (t) {
        line += chalk.hex(t)("▀");
      } else if (b) {
        line += chalk.hex(b)("▄");
      } else {
        line += " ";
      }
    }
    lines.push(line);
  }
  return lines;
}
