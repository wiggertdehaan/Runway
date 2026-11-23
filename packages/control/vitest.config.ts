import { defineConfig } from "vitest/config";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default defineConfig({
  test: {
    // Only the sources: a previous `pnpm build` leaves compiled copies of
    // the tests in dist/ that must not run (or double-count).
    include: ["src/**/*.test.ts"],
    // Modules that import db/index.ts open a database at import time. With
    // several test files in parallel workers a shared on-disk file races on
    // its WAL pragma ("database is locked"), so tests get a private
    // in-memory database each.
    // Route tests that save an app write its Traefik file; keep that out of /gateway-config.
    env: {
      DB_PATH: ":memory:",
      GATEWAY_CONFIG_DIR: join(tmpdir(), "runway-test-gateway"),
      // Deploy uploads are streamed to disk; keep them out of ./uploads.
      UPLOAD_DIR: join(tmpdir(), "runway-test-uploads"),
    },
  },
});
