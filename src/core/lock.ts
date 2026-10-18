import * as fs from "node:fs";
import * as path from "node:path";

/** Is a process with this PID still running? */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 only checks existence
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * One running anonymus per profile: two instances watching the same pair of
 * folders would race on writes and on the sync state. Returns a release
 * function, or the PID of the instance that already holds the lock.
 */
export function acquireLock(dir: string): { release: () => void } | { heldBy: number } {
  const file = path.join(dir, "lock");
  fs.mkdirSync(dir, { recursive: true });
  try {
    const pid = Number(fs.readFileSync(file, "utf8").trim());
    if (pid && pid !== process.pid && alive(pid)) {
      return { heldBy: pid };
    }
  } catch {
    // No lock file yet.
  }
  fs.writeFileSync(file, String(process.pid), "utf8");
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      try {
        if (fs.readFileSync(file, "utf8").trim() === String(process.pid)) {
          fs.rmSync(file, { force: true });
        }
      } catch {
        // Already gone.
      }
    },
  };
}
