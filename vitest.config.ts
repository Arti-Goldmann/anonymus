import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Most tests drive real git repositories, worktrees and file watchers;
    // run side by side on Windows they need more than the default 5 s.
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
