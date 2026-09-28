// Fresh database: migrations + demo data (60 days, deals with periods) — the same path as
// "Загрузить демо-данные" and `npm run db:demo`.
import { execSync } from "node:child_process";
import pg from "pg";
import { E2E_DATABASE_URL } from "../../playwright.config";

export default async function globalSetup() {
  const admin = new pg.Client({ connectionString: E2E_DATABASE_URL.replace(/\/tubestat_e2e(\?|$)/, "/postgres$1") });
  await admin.connect();
  await admin.query("DROP DATABASE IF EXISTS tubestat_e2e WITH (FORCE)");
  await admin.query("CREATE DATABASE tubestat_e2e");
  await admin.end();
  const env = { ...process.env, DATABASE_URL: E2E_DATABASE_URL };
  execSync("npx prisma migrate deploy", { env, stdio: "inherit" });
  execSync("npx tsx prisma/demo.ts", { env, stdio: "inherit" });
}
