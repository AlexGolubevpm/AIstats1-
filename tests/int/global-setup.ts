// Integration tests run against a real Postgres: a fresh database per run, all migrations
// applied. TEST_DATABASE_URL points at a server where the user may create databases
// (CI: postgres service container; locally: any dev Postgres).
import { execSync } from "node:child_process";
import pg from "pg";

export default async function setup() {
  const base = process.env.TEST_DATABASE_URL ?? "postgresql://postgres@127.0.0.1:55432/postgres";
  const dbName = `tubestat_test_${process.pid}`;
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  const url = new URL(base);
  url.pathname = `/${dbName}`;
  process.env.DATABASE_URL = url.toString();
  execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: url.toString() }, stdio: "pipe" });
  return async () => {
    const c = new pg.Client({ connectionString: base });
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await c.end();
  };
}
