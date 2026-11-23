import { defineConfig } from "vitest/config";

export default defineConfig({
  // Sources only: a previous `pnpm build` leaves compiled copies in dist/.
  test: { include: ["src/**/*.test.ts"] },
});
