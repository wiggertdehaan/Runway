import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only the sources: a previous `pnpm build` leaves compiled copies of
    // the tests in dist/ that must not run (or double-count).
    include: ["src/**/*.test.ts"],
    // Modules that import db/index.ts open a database at import time. With
    // several test files in parallel workers a shared on-disk file races on
    // its WAL pragma ("database is locked"), so tests get a private
    // in-memory database each.
    env: { DB_PATH: ":memory:" },
  },
});
