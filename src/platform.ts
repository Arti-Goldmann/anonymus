import { spawn } from "node:child_process";
import * as fs from "node:fs";

/** Open a folder in the system file manager (best effort, never throws). */
export function openFolder(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const cmd = process.platform === "win32" ? "explorer" : process.platform === "darwin" ? "open" : "xdg-open";
    spawn(cmd, [dir], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // Nothing useful to do: the path is shown in the log anyway.
  }
}
