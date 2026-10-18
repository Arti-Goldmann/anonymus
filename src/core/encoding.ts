import iconv from "iconv-lite";

/** Concrete encoding a file is read from / written to. */
export type Encoding = "utf8" | "win1251";

/** Config setting: "auto" detects per-file; the others force one encoding. */
export type EncodingSetting = "auto" | "utf8" | "win1251";

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  );
}

/** Strict UTF-8 validity check (pure ASCII counts as valid UTF-8). */
function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    // fatal: true makes the decoder throw on any invalid byte sequence.
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decides which encoding to use for a file.
 * - explicit setting ("utf8" / "win1251") wins;
 * - "auto": a UTF-8 BOM or fully-valid UTF-8 bytes → utf8, otherwise win1251.
 *
 * Pure-ASCII files are valid UTF-8 and are byte-identical in both encodings,
 * so they are treated as utf8 and round-trip without any change.
 */
export function resolveEncoding(
  bytes: Uint8Array,
  setting: EncodingSetting
): Encoding {
  if (setting === "utf8" || setting === "win1251") {
    return setting;
  }
  if (hasUtf8Bom(bytes)) {
    return "utf8";
  }
  return isValidUtf8(bytes) ? "utf8" : "win1251";
}

/** Decode raw bytes to a JS string using the given encoding. */
export function decode(bytes: Uint8Array, enc: Encoding): string {
  if (enc === "win1251") {
    return iconv.decode(Buffer.from(bytes), "win1251");
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Encode a JS string back to bytes in the given encoding. */
export function encode(text: string, enc: Encoding): Buffer {
  if (enc === "win1251") {
    return iconv.encode(text, "win1251");
  }
  return Buffer.from(text, "utf8");
}

/**
 * Convenience: detect (or force) encoding and decode in one step, returning
 * both the text and the encoding that was used (needed to write it back the
 * same way).
 */
export function decodeAuto(
  bytes: Uint8Array,
  setting: EncodingSetting
): { text: string; encoding: Encoding } {
  const encoding = resolveEncoding(bytes, setting);
  return { text: decode(bytes, encoding), encoding };
}
