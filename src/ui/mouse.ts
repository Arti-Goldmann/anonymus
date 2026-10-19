import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { DOMElement } from "ink";

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
  /** Left button pressed at a 0-based screen cell. */
  click: [{ x: number; y: number }];
}

/** Wheel and click events for whoever shows something scrollable or clickable (see PairsView). */
export const mouseBus = new EventEmitter<MouseEvents>();

/** Screen rectangle of an Ink element, 0-based cells, from its computed layout. */
export function screenRect(el: DOMElement | null): { x: number; y: number; width: number; height: number } | null {
  const node = el?.yogaNode;
  if (!el || !node) {
    return null;
  }
  let x = 0;
  let y = 0;
  for (let n: DOMElement | undefined = el; n; n = n.parentNode) {
    x += n.yogaNode?.getComputedLeft() ?? 0;
    y += n.yogaNode?.getComputedTop() ?? 0;
  }
  return { x, y, width: node.getComputedWidth(), height: node.getComputedHeight() };
}

/** Is a click inside an element? */
export function hits(el: DOMElement | null, click: { x: number; y: number }): boolean {
  const r = screenRect(el);
  return !!r && click.x >= r.x && click.x < r.x + r.width && click.y >= r.y && click.y < r.y + r.height;
}

const SGR_MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
/** The start of a mouse sequence cut off at the end of a chunk. */
const PARTIAL = /\x1b(\[(<[\d;]*)?)?$/;

const LEFT_BUTTON = 0;
const WHEEL_UP = 64;
const WHEEL_DOWN = 65;

/**
 * Take the mouse sequences out of one chunk of terminal input. Wheel steps go
 * to the mouse bus when someone listens, otherwise they become ↑ / ↓ keys
 * (lists on other screens keep scrolling with the wheel as before). Left
 * clicks go to the bus, other buttons are dropped. Returns what is left for Ink.
 */
export function filterMouse(chunk: string): string {
  return chunk.replace(SGR_MOUSE, (_m, button: string, x: string, y: string, kind: string) => {
    const b = Number(button);
    if (b === LEFT_BUTTON && kind === "M") {
      mouseBus.emit("click", { x: Number(x) - 1, y: Number(y) - 1 });
      return "";
    }
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
