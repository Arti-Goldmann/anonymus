import { useRef, useState } from "react";
import { Text, useInput } from "ink";

/**
 * One-line text input. The text and the cursor live in a ref that every key
 * updates at once, so fast typing never loses letters: a controlled input
 * reads its value from the last render and, when renders lag behind the
 * keyboard, overwrites what was just typed and misplaces the cursor.
 *
 * Keys: letters, ← → Home End, Backspace, Delete, Enter (submit). Tab and Esc
 * are left to the screen around it.
 */
export function LineInput({
  initial = "",
  onChange,
  onSubmit,
  active = true,
}: {
  initial?: string;
  onChange?: (value: string) => void;
  onSubmit: (value: string) => void;
  active?: boolean;
}) {
  const state = useRef({ value: initial, cursor: initial.length });
  const [, redraw] = useState(0);

  useInput(
    (input, key) => {
      const s = state.current;
      if (key.return) {
        onSubmit(s.value);
        return;
      }
      if (key.tab || key.escape || key.upArrow || key.downArrow || key.pageUp || key.pageDown) {
        return;
      }
      let { value, cursor } = s;
      if (key.leftArrow) {
        cursor = Math.max(0, cursor - 1);
      } else if (key.rightArrow) {
        cursor = Math.min(value.length, cursor + 1);
      } else if (key.backspace || (key.delete && input === "")) {
        // Most terminals send Backspace as DEL (0x7f), which Ink reports as `delete`.
        if (cursor > 0) {
          value = value.slice(0, cursor - 1) + value.slice(cursor);
          cursor--;
        }
      } else if (key.ctrl && input === "a") {
        cursor = 0;
      } else if (key.ctrl && input === "e") {
        cursor = value.length;
      } else if (!key.ctrl && !key.meta && input) {
        // Keys typed while the screen was busy arrive in one chunk — letters
        // and backspaces mixed: apply them one by one. Other control
        // characters never go in.
        for (const ch of input) {
          if (ch === "\x7f" || ch === "\b") {
            if (cursor > 0) {
              value = value.slice(0, cursor - 1) + value.slice(cursor);
              cursor--;
            }
          } else if (ch >= " ") {
            value = value.slice(0, cursor) + ch + value.slice(cursor);
            cursor++;
          }
        }
      } else {
        return;
      }
      if (value !== s.value || cursor !== s.cursor) {
        const changed = value !== s.value;
        state.current = { value, cursor };
        redraw((n) => n + 1);
        if (changed) {
          onChange?.(value);
        }
      }
    },
    { isActive: active }
  );

  const { value, cursor } = state.current;
  const at = value[cursor] ?? " ";
  return (
    <Text>
      {value.slice(0, cursor)}
      <Text inverse>{at}</Text>
      {value.slice(cursor + 1)}
    </Text>
  );
}
