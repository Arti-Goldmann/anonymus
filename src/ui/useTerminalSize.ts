import { useEffect, useState } from "react";
import { useStdout } from "ink";

export interface TerminalSize {
  columns: number;
  rows: number;
}

/** Current terminal size; re-renders the component whenever the window is resized. */
export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const read = (): TerminalSize => ({
    columns: stdout?.columns || 80,
    rows: stdout?.rows || 24,
  });
  const [size, setSize] = useState<TerminalSize>(read);

  useEffect(() => {
    if (!stdout) {
      return;
    }
    // Wipe the screen first: the frame is redrawn from the top-left corner,
    // and nothing of the old-size frame may stay visible.
    const onResize = () => {
      stdout.write("\x1b[2J\x1b[H");
      setSize(read());
    };
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stdout]);

  return size;
}
