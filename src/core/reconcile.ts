import type { FileStatus, SyncEngine, TransferResult } from "./engine.js";
import type { ScanResult } from "./scanner.js";

export type Strategy = "project-wins" | "sandbox-wins" | "smart" | "manual";

export type ActionType =
  | "to-sandbox"
  | "to-project"
  | "delete-sandbox"
  | "delete-project"
  | "auto-merge"
  | "record" // already equal, just remember it as synced
  | "user"; // needs a human decision

export interface Action {
  type: ActionType;
  status: FileStatus;
}

export interface PlanSummary {
  toSandbox: number;
  toProject: number;
  deleteSandbox: number;
  deleteProject: number;
  autoMerge: number;
  user: number;
}

/**
 * Decide what to do with every file before live sync starts.
 *
 * - project-wins / sandbox-wins: the winning side is mirrored onto the other
 *   (extra files there are deleted, with a backup).
 * - smart: one-sided changes go to the other side, both-sided changes are
 *   3-way merged, anything ambiguous is left to the user.
 * - manual: every difference is left to the user.
 */
export function planReconcile(scan: ScanResult, strategy: Strategy): Action[] {
  const actions: Action[] = [];
  // Safety net: an empty (or freshly wiped) side must never make the smart
  // strategy delete everything on the other side — refill it instead.
  const sandboxEmpty = scan.sandboxFiles === 0;
  const projectEmpty = scan.projectFiles === 0;

  for (const status of scan.statuses) {
    const push = (type: ActionType) => actions.push({ type, status });
    const projectExists = !["only-sandbox", "deleted-in-project"].includes(status.kind) &&
      status.deletedOn !== "project";
    const sandboxExists = !["only-project", "deleted-in-sandbox"].includes(status.kind) &&
      status.deletedOn !== "sandbox";

    if (status.kind === "error") {
      continue;
    }
    if (status.kind === "synced") {
      push("record");
      continue;
    }

    switch (strategy) {
      case "project-wins":
        push(projectExists ? "to-sandbox" : "delete-sandbox");
        break;
      case "sandbox-wins":
        push(sandboxExists ? "to-project" : "delete-project");
        break;
      case "manual":
        push("user");
        break;
      case "smart":
        switch (status.kind) {
          case "only-project":
          case "project-changed":
            push("to-sandbox");
            break;
          case "only-sandbox":
          case "sandbox-changed":
            push("to-project");
            break;
          case "deleted-in-sandbox":
            push(sandboxEmpty ? "to-sandbox" : "delete-project");
            break;
          case "deleted-in-project":
            push(projectEmpty ? "to-project" : "delete-sandbox");
            break;
          case "both-changed":
            push(status.deletedOn || status.binary ? "user" : "auto-merge");
            break;
          default:
            push("user");
        }
        break;
    }
  }
  return actions;
}

export function summarize(actions: Action[]): PlanSummary {
  const s: PlanSummary = { toSandbox: 0, toProject: 0, deleteSandbox: 0, deleteProject: 0, autoMerge: 0, user: 0 };
  for (const a of actions) {
    if (a.type === "to-sandbox") s.toSandbox++;
    else if (a.type === "to-project") s.toProject++;
    else if (a.type === "delete-sandbox") s.deleteSandbox++;
    else if (a.type === "delete-project") s.deleteProject++;
    else if (a.type === "auto-merge") s.autoMerge++;
    else if (a.type === "user") s.user++;
  }
  return s;
}

export interface ReconcileOutcome {
  transfers: TransferResult[];
  deleted: number;
  merged: number;
  /** Files left for the user (including merges that failed). */
  held: FileStatus[];
  failures: { status: FileStatus; error: string }[];
}

const tick = () => new Promise<void>((r) => setImmediate(r));

/** Execute a plan. State is flushed periodically and at the end. */
export async function applyReconcile(
  engine: SyncEngine,
  actions: Action[],
  onProgress?: (done: number, total: number) => void
): Promise<ReconcileOutcome> {
  const out: ReconcileOutcome = { transfers: [], deleted: 0, merged: 0, held: [], failures: [] };

  for (let i = 0; i < actions.length; i++) {
    const { type, status } = actions[i];
    try {
      switch (type) {
        case "record":
          engine.record(status.canonical);
          break;
        case "to-sandbox":
          out.transfers.push(engine.copy("project", status.canonical));
          break;
        case "to-project":
          out.transfers.push(engine.copy("sandbox", status.canonical));
          break;
        case "delete-sandbox":
          engine.remove("sandbox", status.canonical);
          out.deleted++;
          break;
        case "delete-project":
          engine.remove("project", status.canonical);
          out.deleted++;
          break;
        case "auto-merge":
          if (engine.autoMerge(status.canonical).ok) {
            out.merged++;
          } else {
            out.held.push(engine.classify(status.canonical));
          }
          break;
        case "user":
          out.held.push(status);
          break;
      }
    } catch (e) {
      out.failures.push({ status, error: (e as Error).message });
    }
    if (i % 100 === 99) {
      engine.flush();
    }
    if (i % 20 === 0) {
      onProgress?.(i, actions.length);
      await tick();
    }
  }
  engine.state.collectGarbage();
  engine.flush();
  onProgress?.(actions.length, actions.length);
  return out;
}
