import * as path from "node:path";
import type { AnonymusConfig } from "../config/schema.js";
import { decode, encode, type Encoding, type EncodingSetting } from "./encoding.js";
import {
  applyEol,
  decodeText,
  encodeText,
  readBytes,
  removeFile,
  sameText,
  sha256,
  walkFiles,
  writeBytes,
  type TextFile,
} from "./fileio.js";
import { SyncFilter } from "./filter.js";
import { diff3Text } from "./merge.js";
import { otherSide, PathMapper, toAbsolute, type Side } from "./paths.js";
import { StateStore } from "./state.js";
import { Transformer } from "./transformer.js";
import { Trash } from "./trash.js";

/** Relation between the two copies of one file. */
export type Kind =
  | "synced"
  | "only-project" // new in the project, never synced
  | "only-sandbox" // new in the sandbox, never synced
  | "project-changed" // changed in the project since the last sync
  | "sandbox-changed" // changed in the sandbox since the last sync
  | "both-changed" // changed on both sides (or changed on one, deleted on the other)
  | "deleted-in-project" // removed in the project, sandbox untouched since sync
  | "deleted-in-sandbox" // removed in the sandbox, project untouched since sync
  | "differs-unknown" // both exist and differ, but there is no usable sync record
  | "gone" // neither side exists any more
  | "ignored" // not covered by include / excluded
  | "error"; // the path cannot be mapped safely

export interface FileStatus {
  canonical: string;
  projectPath: string;
  sandboxPath: string;
  kind: Kind;
  binary: boolean;
  /** For `both-changed`: the side on which the file was deleted, if any. */
  deletedOn?: Side;
  problem?: string;
}

/** Result of writing one file from one side to the other. */
export interface TransferResult {
  canonical: string;
  from: Side;
  to: Side;
  replacements: number;
  /** Real values still present in text written to the sandbox. */
  leaks: string[];
  backup: string | null;
  warnings: string[];
}

export interface PathError {
  side: Side;
  path: string;
  problem: string;
}

/**
 * The sync core shared by the startup scan, bulk reconciliation and the live
 * watcher. Every decision is made from what is on disk right now plus the
 * last sync record, so processing a file twice is harmless.
 */
export class SyncEngine {
  readonly transformer: Transformer;
  readonly mapper: PathMapper;
  readonly filter: SyncFilter;
  readonly state: StateStore;
  readonly trash: Trash;

  constructor(readonly config: AnonymusConfig) {
    this.transformer = new Transformer(config.replacements);
    this.mapper = new PathMapper(this.transformer);
    this.filter = new SyncFilter(config.sync);
    this.state = new StateStore(config.projectRoot, config.profile.name);
    this.trash = new Trash(config.projectRoot);
  }

  get projectRoot(): string {
    return this.config.projectRoot;
  }

  get sandboxRoot(): string {
    return this.config.profile.sandboxRoot;
  }

  root(side: Side): string {
    return side === "project" ? this.projectRoot : this.sandboxRoot;
  }

  abs(side: Side, canonical: string): string {
    return toAbsolute(this.root(side), this.mapper.sidePath(side, canonical));
  }

  read(side: Side, canonical: string): Buffer | null {
    return readBytes(this.abs(side, canonical));
  }

  /** Canonical path of a file seen on `side` (relative POSIX path there). */
  canonicalOf(side: Side, relPath: string): string {
    return side === "project" ? relPath : this.mapper.toCanonical(relPath);
  }

  private encodingSetting(side: Side): EncodingSetting {
    return side === "sandbox" && this.config.sync.sandboxEncoding === "utf8"
      ? "utf8"
      : this.config.sync.encoding;
  }

  decodeSide(side: Side, bytes: Uint8Array): TextFile {
    return decodeText(bytes, this.encodingSetting(side));
  }

  /** Are the two copies equivalent once replacements are applied? */
  inSync(canonical: string, project: Buffer, sandbox: Buffer): boolean {
    if (this.filter.isBinary(canonical)) {
      return project.equals(sandbox);
    }
    const p = this.decodeSide("project", project);
    const s = this.decodeSide("sandbox", sandbox);
    return sameText(this.transformer.anonymize(p.text).text, s.text);
  }

  classify(canonical: string): FileStatus {
    const base: FileStatus = {
      canonical,
      projectPath: canonical,
      sandboxPath: this.mapper.toSandbox(canonical),
      kind: "synced",
      binary: this.filter.isBinary(canonical),
    };
    if (!this.filter.isSynced(canonical)) {
      return { ...base, kind: "ignored" };
    }
    const problem = this.mapper.projectPathProblem(canonical);
    if (problem) {
      return { ...base, kind: "error", problem };
    }

    const p = this.read("project", canonical);
    const s = this.read("sandbox", canonical);
    const entry = this.state.get(canonical);

    if (!p && !s) {
      return { ...base, kind: "gone" };
    }
    if (p && s) {
      if (this.inSync(canonical, p, s)) {
        return base;
      }
      if (!entry) {
        return { ...base, kind: "differs-unknown" };
      }
      const pc = sha256(p) !== entry.projectHash;
      const sc = sha256(s) !== entry.sandboxHash;
      if (pc && sc) {
        return { ...base, kind: "both-changed" };
      }
      if (pc) {
        return { ...base, kind: "project-changed" };
      }
      if (sc) {
        return { ...base, kind: "sandbox-changed" };
      }
      // Bytes match the record, yet they no longer correspond: the
      // replacement table changed since the last sync.
      return { ...base, kind: "differs-unknown" };
    }
    if (p) {
      if (!entry) {
        return { ...base, kind: "only-project" };
      }
      return sha256(p) === entry.projectHash
        ? { ...base, kind: "deleted-in-sandbox" }
        : { ...base, kind: "both-changed", deletedOn: "sandbox" };
    }
    if (!entry) {
      return { ...base, kind: "only-sandbox" };
    }
    return sha256(s!) === entry.sandboxHash
      ? { ...base, kind: "deleted-in-project" }
      : { ...base, kind: "both-changed", deletedOn: "project" };
  }

  /**
   * All candidate files: synced files present on either side plus everything
   * the state remembers (to notice deletions). Paths that cannot be mapped
   * safely are reported separately and never synced.
   */
  listCandidates(): { canonicals: string[]; pathErrors: PathError[] } {
    const pathErrors: PathError[] = [];
    const set = new Set<string>();

    const projectFiles = walkFiles(this.projectRoot, (d) => this.filter.isDirExcluded(d));
    for (const rel of projectFiles) {
      if (!this.filter.isSynced(rel)) {
        continue;
      }
      const problem = this.mapper.projectPathProblem(rel);
      if (problem) {
        pathErrors.push({ side: "project", path: rel, problem });
      } else {
        set.add(rel);
      }
    }

    const sandboxFiles = walkFiles(this.sandboxRoot, (d) =>
      this.filter.isDirExcluded(this.mapper.toCanonical(d))
    );
    for (const rel of sandboxFiles) {
      const canonical = this.mapper.toCanonical(rel);
      if (!this.filter.isSynced(canonical)) {
        continue;
      }
      const problem = this.mapper.sandboxPathProblem(rel);
      if (problem) {
        pathErrors.push({ side: "sandbox", path: rel, problem });
      } else {
        set.add(canonical);
      }
    }

    for (const key of this.state.keys()) {
      set.add(key);
    }
    return { canonicals: [...set].sort(), pathErrors };
  }

  /** Remember both sides as "in sync" right now (or forget a vanished file). */
  record(canonical: string): void {
    const p = this.read("project", canonical);
    const s = this.read("sandbox", canonical);
    if (!p || !s) {
      this.state.delete(canonical);
      return;
    }
    this.state.set(
      {
        projectPath: canonical,
        sandboxPath: this.mapper.toSandbox(canonical),
        projectHash: sha256(p),
        sandboxHash: sha256(s),
        binary: this.filter.isBinary(canonical),
        syncedAt: new Date().toISOString(),
      },
      s
    );
  }

  flush(): void {
    this.state.save();
  }

  /** Is the file on `side` exactly what the last sync left there? */
  private matchesRecord(side: Side, canonical: string, bytes: Buffer): boolean {
    const entry = this.state.get(canonical);
    if (!entry) {
      return false;
    }
    return sha256(bytes) === (side === "project" ? entry.projectHash : entry.sandboxHash);
  }

  /** Encoding to write a text file with on `side`. */
  private targetEncoding(side: Side, existing: TextFile | null, sourceEncoding: Encoding): Encoding {
    if (side === "sandbox" && this.config.sync.sandboxEncoding === "utf8") {
      return "utf8";
    }
    if (existing) {
      return existing.encoding; // keep whatever the file already uses
    }
    const setting = this.config.sync.encoding;
    return setting === "auto" ? sourceEncoding : setting;
  }

  /**
   * Write text (already in the form of `side`) to `side`, keeping the target
   * file's encoding, BOM and line-ending style. Content that is not part of
   * the last sync is backed up first.
   */
  private writeText(
    side: Side,
    canonical: string,
    text: string,
    source: { encoding: Encoding; bom: boolean },
    warnings: string[]
  ): string | null {
    const abs = this.abs(side, canonical);
    const existingBytes = readBytes(abs);
    const existing = existingBytes ? this.decodeSide(side, existingBytes) : null;
    const encoding = this.targetEncoding(side, existing, source.encoding);
    const bom = existing ? existing.bom : source.bom;
    const body = existing?.eol ? applyEol(text, existing.eol) : text;

    if (encoding === "win1251" && decode(encode(body, "win1251"), "win1251") !== body) {
      warnings.push("символы, которых нет в win1251, заменены на «?»");
    }
    const bytes = encodeText(body, encoding, bom);
    if (existingBytes && existingBytes.equals(bytes)) {
      return null;
    }
    const backup =
      existingBytes && !this.matchesRecord(side, canonical, existingBytes)
        ? this.trash.backup(side, this.mapper.sidePath(side, canonical), abs)
        : null;
    writeBytes(abs, bytes);
    return backup;
  }

  /** Copy a file from `from` to the other side, transforming text. */
  copy(from: Side, canonical: string): TransferResult {
    const to = otherSide(from);
    const src = this.read(from, canonical);
    if (!src) {
      throw new Error(`${this.mapper.sidePath(from, canonical)}: файла нет`);
    }
    const result: TransferResult = {
      canonical,
      from,
      to,
      replacements: 0,
      leaks: [],
      backup: null,
      warnings: [],
    };

    if (this.filter.isBinary(canonical)) {
      const abs = this.abs(to, canonical);
      const existing = readBytes(abs);
      if (existing && !this.matchesRecord(to, canonical, existing) && !existing.equals(src)) {
        result.backup = this.trash.backup(to, this.mapper.sidePath(to, canonical), abs);
      }
      writeBytes(abs, src);
    } else {
      const decoded = this.decodeSide(from, src);
      const transformed =
        from === "project"
          ? this.transformer.anonymize(decoded.text)
          : this.transformer.deanonymize(decoded.text);
      result.replacements = transformed.applied.reduce((n, a) => n + a.count, 0);
      if (to === "sandbox") {
        result.leaks = this.transformer.findLeaks(transformed.text);
      }
      result.backup = this.writeText(to, canonical, transformed.text, decoded, result.warnings);
    }
    this.record(canonical);
    return result;
  }

  /** Delete the file on `side` (backed up first) and forget it. */
  remove(side: Side, canonical: string): string | null {
    const abs = this.abs(side, canonical);
    const backup = this.trash.backup(side, this.mapper.sidePath(side, canonical), abs);
    removeFile(abs, this.root(side));
    this.state.delete(canonical);
    return backup;
  }

  /** Last-synced sandbox text of a file, if a base snapshot exists. */
  baseText(canonical: string): string | null {
    const bytes = this.state.getBase(canonical);
    return bytes ? this.decodeSide("sandbox", bytes).text : null;
  }

  /**
   * Three-way merge of a file changed on both sides, done in sandbox form:
   * base = last synced sandbox text, ours = anonymized project, theirs =
   * sandbox. On success both sides get the merged text.
   */
  autoMerge(canonical: string): { ok: true; warnings: string[] } | { ok: false } {
    const p = this.read("project", canonical);
    const s = this.read("sandbox", canonical);
    const base = this.baseText(canonical);
    if (!p || !s || base === null || this.filter.isBinary(canonical)) {
      return { ok: false };
    }
    const pf = this.decodeSide("project", p);
    const sf = this.decodeSide("sandbox", s);
    const merged = diff3Text(this.transformer.anonymize(pf.text).text, base, sf.text);
    if (merged.conflict) {
      return { ok: false };
    }
    const warnings: string[] = [];
    this.writeText("sandbox", canonical, merged.text, sf, warnings);
    this.writeText(
      "project",
      canonical,
      this.transformer.deanonymize(merged.text).text,
      pf,
      warnings
    );
    this.record(canonical);
    return { ok: true, warnings };
  }

  /**
   * Write a final, human-resolved project-form text to both sides (used after
   * a manual merge).
   */
  writeResolved(canonical: string, projectText: string): TransferResult {
    const warnings: string[] = [];
    const p = this.read("project", canonical);
    const s = this.read("sandbox", canonical);
    const pf = p ? this.decodeSide("project", p) : null;
    const sf = s ? this.decodeSide("sandbox", s) : null;
    const fallback = pf ?? sf ?? { encoding: "utf8" as Encoding, bom: false };
    const backup = this.writeText("project", canonical, projectText, pf ?? fallback, warnings);
    const anon = this.transformer.anonymize(projectText);
    this.writeText("sandbox", canonical, anon.text, sf ?? fallback, warnings);
    this.record(canonical);
    return {
      canonical,
      from: "project",
      to: "sandbox",
      replacements: anon.applied.reduce((n, a) => n + a.count, 0),
      leaks: this.transformer.findLeaks(anon.text),
      backup,
      warnings,
    };
  }

  /** Path shown to the user for a file on a side, relative to that root. */
  display(side: Side, canonical: string): string {
    return this.mapper.sidePath(side, canonical).split("/").join(path.sep);
  }
}
