import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

/**
 * Mouse wheel support. In the alternate screen a terminal turns the wheel
 * into ↑ / ↓ keys, indistinguishable from the real arrows. With mouse
 * reporting on (SGR encoding) the wheel arrives as its own sequence
 * `ESC [ < 64|65 ; x ; y M`, so the arrows can keep selecting pairs while the
 * wheel scrolls the journal.
 *
 * Side effect of mouse reporting: plain drag no longer selects text in the
 * terminal — hold Shift while dragging (VS Code, Windows Terminal).
 */
export const MOUSE_ON = "\x1b[?1000h\x1b[?1006h";
export const MOUSE_OFF = "\x1b[?1000l\x1b[?1006l";

interface MouseEvents {
  /** -1: wheel up (towards older lines), +1: wheel down. */
  wheel: [number];
}

/** Wheel events for whoever shows something scrollable (see PairsView). */
export const mouseBus = new EventEmitter<MouseEvents>();

const SGR_MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
/** The start of a mouse sequence cut off at the end of a chunk. */
const PARTIAL = /\x1b(\[(<[\d;]*)?)?$/;

const WHEEL_UP = 64;
const WHEEL_DOWN = 65;

/**
 * Take the mouse sequences out of one chunk of terminal input. Wheel steps go
 * to the mouse bus when someone listens, otherwise they become ↑ / ↓ keys
 * (lists on other screens keep scrolling with the wheel as before). Clicks
 * are dropped. Returns what is left for Ink.
 */
export function filterMouse(chunk: string): string {
  return chunk.replace(SGR_MOUSE, (_m, button: string) => {
    const b = Number(button);
    if (b !== WHEEL_UP && b !== WHEEL_DOWN) {
      return "";
    }
    const dir = b === WHEEL_UP ? -1 : 1;
    if (mouseBus.listenerCount("wheel") > 0) {
      mouseBus.emit("wheel", dir);
      return "";
    }
    return dir < 0 ? "\x1b[A" : "\x1b[B";
  });
}

type InputStream = NodeJS.ReadableStream & {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  ref?: () => unknown;
  unref?: () => unknown;
};

/**
 * A stdin for Ink without the mouse sequences: everything else passes
 * through unchanged; raw mode and ref / unref are forwarded to the real stdin.
 */
export function mouseFilteredStdin(stdin: InputStream): NodeJS.ReadStream {
  const out = new PassThrough();
  let pending = "";
  stdin.on("data", (data: Buffer | string) => {
    let text = pending + data.toString();
    pending = "";
    const partial = PARTIAL.exec(text);
    // A lone ESC is the Escape key, not the start of a sequence: pass it on.
    if (partial && partial[0].length > 1) {
      pending = partial[0];
      text = text.slice(0, partial.index);
    }
    const rest = filterMouse(text);
    if (rest) {
      out.write(rest);
    }
  });
  return Object.assign(out, {
    isTTY: true,
    setRawMode: (mode: boolean) => {
      stdin.setRawMode?.(mode);
      return out;
    },
    ref: () => {
      stdin.ref?.();
      return out;
    },
    unref: () => {
      stdin.unref?.();
      return out;
    },
  }) as unknown as NodeJS.ReadStream;
}
