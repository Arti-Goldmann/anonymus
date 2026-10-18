/**
 * Flicker-free output for Ink on a full-screen (alternate screen) UI.
 *
 * Ink redraws a frame by first erasing every previous line bottom-up
 * (`ESC[2K ESC[1A` ... `ESC[G`) and then printing the whole frame again.
 * Windows Terminal often paints the moment in between, so the screen blinks
 * on every update. This wrapper rewrites each frame as an in-place update:
 * every line is put at its absolute row and replaced right away, then the rest
 * of the screen below is cleared. The whole frame is also wrapped in
 * "synchronized output" (DEC mode 2026), which terminals that support it
 * display atomically; others ignore the sequence.
 */

const ESC = "\x1b[";
/** Ink's erase of the previous frame (ansi-escapes eraseLines). */
const ERASE_PREVIOUS = /^(?:\x1b\[2K\x1b\[1A)*\x1b\[2K\x1b\[G/;
const SYNC_BEGIN = `${ESC}?2026h`;
const SYNC_END = `${ESC}?2026l`;

/** Turn one Ink frame into an absolute, in-place repaint of the screen. */
export function frameToInPlace(frame: string): string {
  let body = frame.replace(ERASE_PREVIOUS, "");
  if (body.endsWith("\n")) {
    body = body.slice(0, -1); // never let the frame scroll the screen
  }
  const lines = body.split("\n");
  // Erase each line just before rewriting it (not all lines up front), so no
  // blank frame can be shown; ESC[J clears whatever was below last time.
  const out = lines.map((line, i) => `${ESC}${i + 1};1H${ESC}2K${line}`).join("");
  return `${out}${ESC}J`;
}

/** Is this write a frame from Ink's renderer (as opposed to a control sequence)? */
function isFrame(text: string): boolean {
  return text.includes("\n") && !text.startsWith(`${ESC}2J`) && !text.startsWith("\x1bc");
}

/** Wrap a TTY stream so Ink's frames are painted in place and atomically. */
export function flickerFreeStdout(real: NodeJS.WriteStream): NodeJS.WriteStream {
  const write = (chunk: unknown, ...rest: unknown[]): boolean => {
    const text = typeof chunk === "string" ? chunk : String(chunk);
    const payload = isFrame(text) ? frameToInPlace(text) : text;
    return (real.write as (...a: unknown[]) => boolean)(SYNC_BEGIN + payload + SYNC_END, ...rest);
  };
  return new Proxy(real, {
    get(target, prop) {
      if (prop === "write") {
        return write;
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
