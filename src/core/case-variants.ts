/**
 * Generation of case variants for a replacement pair.
 *
 * For `variants: auto` we tokenize both the real and placeholder strings into
 * words, then re-assemble them in a set of common casing styles so that e.g.
 * `Romashka` also matches `romashka`, `ROMASHKA`, `romashka_id`, `romashkaService`.
 *
 * Each entry is a `{ from, to }` pair. Application (regex escaping, ordering by
 * length) is the Transformer's responsibility.
 */

export interface VariantPair {
  from: string;
  to: string;
}

function splitWords(spaced: string): string[] {
  return spaced
    .split(/[\s_\-./]+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
}

/** Split a string into lowercase word tokens, handling camelCase, snake/kebab and spaces. */
export function tokenize(input: string): string[] {
  return splitWords(
    input
      // split camelCase / PascalCase boundaries
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
  );
}

/**
 * All plausible word splits of a name. A capital run followed by lowercase is
 * ambiguous: `HTTPServer` is "http server", but `BIGcorpProject` is
 * "bigcorp project", not "bi gcorp project". The split at lower→upper
 * boundaries only comes first; the acronym-aware split is added when it
 * differs, so both spellings get anonymized.
 */
export function tokenizations(input: string): string[][] {
  const plain = splitWords(input.replace(/([a-z0-9])([A-Z])/g, "$1 $2"));
  const acronym = tokenize(input);
  return plain.join(" ") === acronym.join(" ") ? [plain] : [plain, acronym];
}

function capitalize(word: string): string {
  if (word.length === 0) {
    return word;
  }
  return word[0].toUpperCase() + word.slice(1);
}

function toCamel(words: string[]): string {
  return words
    .map((w, i) => (i === 0 ? w : capitalize(w)))
    .join("");
}

function toPascal(words: string[]): string {
  return words.map(capitalize).join("");
}

function toSnake(words: string[]): string {
  return words.join("_");
}

function toScreamingSnake(words: string[]): string {
  return words.map((w) => w.toUpperCase()).join("_");
}

function toKebab(words: string[]): string {
  return words.join("-");
}

function toLower(words: string[]): string {
  return words.join("");
}

function toUpper(words: string[]): string {
  return words.map((w) => w.toUpperCase()).join("");
}

/**
 * Produce all auto-generated case variants mapping `real` -> `placeholder`.
 * The list is de-duplicated by the `from` value (first occurrence wins).
 */
export function generateAutoVariants(real: string, placeholder: string): VariantPair[] {
  const realSplits = tokenizations(real);
  const phSplits = tokenizations(placeholder);

  // If tokenization fails (e.g. punctuation-only), fall back to exact.
  if (realSplits[0].length === 0 || phSplits[0].length === 0) {
    return [{ from: real, to: placeholder }];
  }

  const builders: Array<(w: string[]) => string> = [
    toCamel,
    toPascal,
    toSnake,
    toScreamingSnake,
    toKebab,
    toLower,
    toUpper,
  ];

  const pairs: VariantPair[] = [
    // original exact form first
    { from: real, to: placeholder },
  ];

  // Pair the i-th split of the real name with the i-th split of the
  // placeholder (or its only split). The preferred split comes first, so
  // when two real spellings map to one placeholder spelling, the reverse
  // replacement restores the preferred one.
  realSplits.forEach((realWords, i) => {
    const phWords = phSplits[Math.min(i, phSplits.length - 1)];
    for (const build of builders) {
      pairs.push({ from: build(realWords), to: build(phWords) });
    }
  });

  // De-duplicate by `from`.
  const seen = new Set<string>();
  const result: VariantPair[] = [];
  for (const pair of pairs) {
    if (pair.from.length === 0 || seen.has(pair.from)) {
      continue;
    }
    seen.add(pair.from);
    result.push(pair);
  }
  return result;
}

/** A single exact replacement pair (no case expansion). */
export function exactVariant(real: string, placeholder: string): VariantPair[] {
  return [{ from: real, to: placeholder }];
}
