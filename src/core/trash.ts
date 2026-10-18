import * as fs from "node:fs";
import * as path from "node:path";
import { SERVICE_DIR } from "../config/schema.js";
import { toAbsolute, type Side } from "./paths.js";

/**
 * Backups of files anonymus is about to delete or overwrite. Every run gets
 * its own folder, `.anonymus/trash/<timestamp>/<project|sandbox>/<path>`, in
 * the project (sandbox copies are already anonymized, so nothing leaks).
 */
export class Trash {
  readonly root: string;
  readonly sessionDir: string;
  private count = 0;

  constructor(projectRoot: string, now = new Date()) {
    this.root = path.join(projectRoot, SERVICE_DIR, "trash");
    const stamp = now.toISOString().replace(/T/, "_").replace(/:/g, "-").replace(/\..+$/, "");
    this.sessionDir = path.join(this.root, stamp);
  }

  get backups(): number {
    return this.count;
  }

  /** Copy the file into the trash; returns the backup path (null if no file). */
  backup(side: Side, relPath: string, absPath: string): string | null {
    if (!fs.existsSync(absPath)) {
      return null;
    }
    let dest = toAbsolute(path.join(this.sessionDir, side), relPath);
    // The same file may be backed up several times in one session.
    for (let i = 1; fs.existsSync(dest); i++) {
      dest = `${toAbsolute(path.join(this.sessionDir, side), relPath)}.${i}`;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(absPath, dest);
    this.count++;
    return dest;
  }
}
