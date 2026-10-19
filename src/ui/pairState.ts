import type { PairProblem } from "../core/pairGuard.js";
import type { MergeRun } from "../core/registry.js";
import type { ScanResult } from "../core/scanner.js";

/** Where a pair is in its life: start-up steps, waiting for the user, syncing, stopped. */
export type Phase = "waiting" | "scanning" | "applying" | "review" | "live" | "blocked";

export interface PairStats {
  toSandbox: number;
  toProject: number;
  deleted: number;
}

/** Everything the screens show about one pair. */
export interface PairView {
  name: string;
  branch: string | null;
  /** Branch the pair was created from. */
  base: string | null;
  phase: Phase;
  problem: PairProblem | null;
  held: number;
  paused: boolean;
  busy: boolean;
  pending: number;
  stats: PairStats;
  progress: [number, number];
  /** Scan waiting for the user's decision (phase "review"). */
  scan: ScanResult | null;
  needsReview: boolean;
  merge: MergeRun | null;
}

export const ZERO_STATS: PairStats = { toSandbox: 0, toProject: 0, deleted: 0 };

/** Does the pair need the user (shown first, counted in the header)? */
export function needsAttention(p: PairView): boolean {
  return p.phase === "review" || p.phase === "blocked" || p.held > 0 || !!p.merge?.current;
}

/** Result of an action, shown under the list. */
export interface ActionResult {
  ok: boolean;
  lines: string[];
}
