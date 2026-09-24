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
      exclude: ["src/generated/**", "src/server/jobs/**"],
      thresholds: { lines: 80 },
    },
  },
});
