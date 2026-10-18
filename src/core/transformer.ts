import type { ReplacementRule } from "../config/schema.js";
import {
  VariantPair,
  generateAutoVariants,
  exactVariant,
} from "./case-variants.js";

export interface AppliedReplacement {
  from: string;
  to: string;
  count: number;
}

export interface TransformResult {
  text: string;
  applied: AppliedReplacement[];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Regex source for `s` where every line break matches a LF or CRLF line break
 * in the target text, so a multi-line pattern written with `\n` also matches
 * Windows CRLF files.
 */
function escapeRegexMultiline(s: string): string {
  return escapeRegex(s).replace(/\n/g, "\\r?\\n");
}

/** The line ending used by most lines of the text ("\n" or "\r\n"). */
function dominantEol(text: string): string {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/(?<!\r)\n/g) || []).length;
  return crlf > lf ? "\r\n" : "\n";
}

/**
 * Applies an ordered list of `{ from, to }` replacements to text.
 * Pairs are sorted by descending `from` length to avoid cascading / partial
 * substitutions (longer, more specific matches win first).
 */
function applyPairs(text: string, pairs: VariantPair[]): TransformResult {
  const sorted = [...pairs].sort((a, b) => b.from.length - a.from.length);
  let result = text;
  const applied: AppliedReplacement[] = [];

  for (const pair of sorted) {
    if (pair.from.length === 0) {
      continue;
    }
    // Multi-line pattern: match line breaks flexibly (LF or CRLF in the
    // file). Multi-line replacement: insert with the file's dominant
    // line-ending style (matched span may be single-line, e.g. placeholder
    // -> multi-line real).
    const fromIsMultiline = pair.from.includes("\n");
    const useCrlf =
      pair.to.includes("\n") && dominantEol(result) === "\r\n";
    const regex = new RegExp(
      fromIsMultiline
        ? escapeRegexMultiline(pair.from)
        : escapeRegex(pair.from),
      "g"
    );
    let count = 0;
    result = result.replace(regex, () => {
      count++;
      return useCrlf ? pair.to.replace(/\n/g, "\r\n") : pair.to;
    });
    if (count > 0) {
      applied.push({ from: pair.from, to: pair.to, count });
    }
  }

  return { text: result, applied };
}

export class Transformer {
  /** real -> placeholder pairs (anonymize). */
  private readonly forward: VariantPair[];
  /** placeholder -> real pairs (deanonymize). */
  private readonly backward: VariantPair[];

  constructor(replacements: readonly ReplacementRule[]) {
    const forward: VariantPair[] = [];
    for (const rule of replacements) {
      const pairs =
        rule.variants === "exact" || rule.real.includes("\n")
          ? exactVariant(rule.real, rule.placeholder)
          : generateAutoVariants(rule.real, rule.placeholder);
      forward.push(...pairs);
    }
    this.forward = forward;
    // Several real spellings may share one placeholder spelling (e.g. both
    // splits of "BIGcorpProject" give "my_project"); the first, preferred
    // one is what the placeholder turns back into.
    const seen = new Set<string>();
    this.backward = [];
    for (const p of forward) {
      if (!seen.has(p.to)) {
        seen.add(p.to);
        this.backward.push({ from: p.to, to: p.from });
      }
    }
    const byKey = new Map<string, string>();
    for (const r of replacements) {
      const key = squash(r.real);
      if (key.length >= 3 && !byKey.has(key)) {
        byKey.set(key, r.real);
      }
    }
    this.squashedReals = [...byKey].map(([key, real]) => ({ key, real }));
  }

  /** Real values with separators removed, for spelling-agnostic leak checks. */
  private readonly squashedReals: { real: string; key: string }[];

  /** main -> sandbox: replace real values with placeholders. */
  anonymize(text: string): TransformResult {
    return applyPairs(text, this.forward);
  }

  /** sandbox -> main: replace placeholders back with real values. */
  deanonymize(text: string): TransformResult {
    return applyPairs(text, this.backward);
  }

  /**
   * Apply the same replacements to a relative path (folder + file names), so
   * keyword-bearing directory/file names are anonymized too. Path separators
   * ("/") are never part of a keyword, so the whole path can be transformed at
   * once. The transform is reversible: deanonymizePath(anonymizePath(p)) === p.
   */
  anonymizePath(relativePath: string): string {
    return this.anonymize(relativePath).text;
  }

  deanonymizePath(relativePath: string): string {
    return this.deanonymize(relativePath).text;
  }

  /**
   * Real values that are still present in already-anonymized text, matched
   * case-insensitively. A non-empty result means the replacement table misses
   * some spelling of a real name (e.g. a casing style `auto` does not cover).
   */
  findLeaks(anonymizedText: string): string[] {
    const haystack = anonymizedText.toLowerCase();
    const leaks = new Set<string>();
    for (const pair of this.forward) {
      if (pair.from.length > 0 && haystack.includes(pair.from.toLowerCase())) {
        leaks.add(pair.from);
      }
    }
    // Any other spelling: "Bigcorp-Project", "BIGCORP PROJECT", ...
    const squashed = squash(anonymizedText);
    for (const { real, key } of this.squashedReals) {
      if (squashed.includes(key)) {
        leaks.add(real);
      }
    }
    return [...leaks];
  }
}

/** Lower-case and drop separators so every spelling of a name compares equal. */
function squash(s: string): string {
  return s.toLowerCase().replace(/[\s_\-.]+/g, "");
}
