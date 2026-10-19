import type { SyncEngine } from "../src/core/engine.js";
import { applyReconcile, planReconcile } from "../src/core/reconcile.js";
import { scan } from "../src/core/scanner.js";
import { Syncer } from "../src/core/syncer.js";
import type { Workspace } from "../src/core/workspace.js";

/** Poll until `check` passes or time runs out. */
export async function waitFor(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timeout waiting for condition");
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fill / reconcile a pair the way the UI does when it is unambiguous. */
export async function reconcilePair(ws: Workspace, name: string): Promise<SyncEngine> {
  const engine = ws.engineFor(name);
  const result = await scan(engine);
  await applyReconcile(engine, planReconcile(result, result.sandboxFiles === 0 ? "project-wins" : "smart"));
  return engine;
}

/** Reconcile a pair and start its live syncer with the workspace's guard. */
export async function livePair(ws: Workspace, name: string): Promise<{ engine: SyncEngine; syncer: Syncer }> {
  const engine = await reconcilePair(ws, name);
  const syncer = new Syncer(engine, [], {
    guard: () => ws.check(name, engine.state.size > 0),
    gitDir: ws.gitDirOf(name),
  });
  await syncer.start();
  return { engine, syncer };
}
