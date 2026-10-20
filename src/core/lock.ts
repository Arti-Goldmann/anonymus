import * as fs from "node:fs";
import * as path from "node:path";

/** How often a running instance refreshes its lock. */
const HEARTBEAT_MS = 2000;
/**
 * A lock not refreshed for this long is abandoned (the process died without
 * cleaning up), even if its PID now belongs to some other program — Windows
 * reuses PIDs quickly.
 */
const STALE_MS = 15_000;

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
 * One running anonymus per project: two instances watching the same folders
 * would race on writes and on the sync state. The lock file holds the PID and
 * is touched every few seconds while the instance runs; a lock whose process
 * is gone, or that has not been touched for a while, is taken over. Returns a
 * release function, or the PID of the instance that holds the lock.
 */
export function acquireLock(dir: string): { release: () => void } | { heldBy: number } {
  const file = path.join(dir, "lock");
  fs.mkdirSync(dir, { recursive: true });
  try {
    const pid = Number(fs.readFileSync(file, "utf8").trim());
    const fresh = Date.now() - fs.statSync(file).mtimeMs < STALE_MS;
    if (pid && pid !== process.pid && fresh && alive(pid)) {
      return { heldBy: pid };
    }
  } catch {
    // No lock file yet.
  }
  fs.writeFileSync(file, String(process.pid), "utf8");
  const heartbeat = setInterval(() => {
    try {
      const now = new Date();
      fs.utimesSync(file, now, now);
    } catch {
      // The file is gone or busy for a moment; the next beat retries.
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
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
