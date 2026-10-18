/**
 * Preprocessing for `.transfer-config.yaml` that lets users paste multi-line
 * text into a double-quoted value with REAL line breaks, e.g.
 *
 *   - real: "Тут много всего написано.
 * Несколько строк прямо."
 *     placeholder: "myProject_cpu02"
 *
 * Standard YAML FOLDS such a line break into a space, silently losing the
 * newline. This pass rewrites those spans into single-line scalars where every
 * raw line break becomes the escape `\n`, so the parsed value is exactly the
 * text the user pasted (verbatim: backslashes and inner quotes included).
 *
 * Closing-quote rule: inside a pasted span, a `"` closes the value only when
 * the rest of the line is empty or a comment (`# ...`). Any other quote is
 * part of the pasted text. Values that open and close on the same line are
 * left untouched, so normal single-line YAML semantics are unchanged.
 */

const KEY_WITH_OPEN_QUOTE =
  /^(\s*(?:-\s*)?(?:real|placeholder|description)\s*:\s*)"/;

/** Line tail that may follow a closing quote (whitespace and/or a comment). */
const CLEAN_TAIL = /^\s*(#.*)?$/;

/**
 * Index of the `"` that closes the value on this line, or -1 if the line does
 * not close it. A quote closes the value only when only whitespace or a
 * comment follows it; quotes followed by text are content.
 */
function findClosingQuote(line: string): number {
  for (let i = line.indexOf('"'); i !== -1; i = line.indexOf('"', i + 1)) {
    if (CLEAN_TAIL.test(line.slice(i + 1))) {
      return i;
    }
  }
  return -1;
}

/** YAML-escape a verbatim pasted line so backslashes and quotes stay literal. */
function yamlEscape(part: string): string {
  return part.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Rewrite multi-line double-quoted `real` / `placeholder` / `description`
 * values into single-line scalars. Everything else passes through unchanged.
 * If a span is never closed, the input is returned as-is so js-yaml reports a
 * natural parse error.
 */
export function preprocessMultilineScalars(raw: string): string {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let prefix = ""; // e.g. `  - real: "` — kept for when the span closes
  let parts: string[] | null = null; // collected content lines of an open span

  for (const line of lines) {
    if (parts === null) {
      const m = line.match(KEY_WITH_OPEN_QUOTE);
      if (m && findClosingQuote(line.slice(m[0].length)) === -1) {
        // Opening quote, nothing closes it on this line -> value continues
        // on the following lines.
        prefix = m[0];
        parts = [line.slice(m[0].length)];
      } else {
        out.push(line);
      }
    } else {
      const q = findClosingQuote(line);
      if (q === -1) {
        parts.push(line);
      } else {
        const body = [...parts, line.slice(0, q)].map(yamlEscape).join("\\n");
        out.push(prefix + body + '"' + line.slice(q + 1));
        parts = null;
      }
    }
  }

  if (parts !== null) {
    return lines.join("\n");
  }
  return out.join("\n");
}

/**
 * Canonical form for replacement values: `\n`-only line endings, with a
 * single trailing newline dropped (YAML `|` blocks always add one). The
 * Transformer re-adapts line endings per file, so values never need to
 * carry `\r` or a trailing newline.
 */
export function normalizeMultilineValue(s: string): string {
  return s.replace(/\r\n?/g, "\n").replace(/\n$/, "");
}
