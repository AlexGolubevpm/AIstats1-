import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const alias = { "@": path.resolve(import.meta.dirname, "src"), "@tests": path.resolve(import.meta.dirname, "tests") };

export default defineConfig({
  plugins: [react()],
  resolve: { alias },
  test: {
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["tests/unit/**/*.test.ts", "tests/components/**/*.test.tsx"], environment: "node" },
      },
      {
        extends: true,
        test: {
          name: "int",
          include: ["tests/int/**/*.test.ts"],
          environment: "node",
          globalSetup: ["tests/int/global-setup.ts"],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["src/lib/**", "src/server/**"],
      // Server actions and the session guard are thin Next.js wrappers (cookies, redirect):
      // they are exercised by the E2E suite (tests/e2e), not by unit/integration tests.
      exclude: ["src/generated/**", "src/server/jobs/**", "src/server/actions/**", "src/server/session.ts"],
      thresholds: { lines: 80 },
    },
  },
});
