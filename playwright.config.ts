// E2E: the production build against a throwaway database with demo data (tests/e2e/global-setup.ts).
import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3300);
const base = process.env.TEST_DATABASE_URL ?? "postgresql://postgres@127.0.0.1:55432/postgres";
export const E2E_DATABASE_URL = base.replace(/\/[^/?]+(\?|$)/, "/tubestat_e2e$1");
export const E2E_PASSWORD = "e2e-password-123";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : undefined,
  },
  webServer: {
    command: `npx next start -p ${PORT}`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { DATABASE_URL: E2E_DATABASE_URL, APP_PASSWORD: E2E_PASSWORD, REDIS_URL: "redis://127.0.0.1:1", NODE_ENV: "production" },
  },
});
