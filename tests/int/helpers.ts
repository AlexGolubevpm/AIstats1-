import { createPrisma } from "@/server/db";
import type { PrismaClient } from "@/generated/prisma/client";

let client: PrismaClient | null = null;
export function testDb(): PrismaClient {
  client ??= createPrisma(process.env.DATABASE_URL);
  return client;
}

/** Empties every table (keeps schema, views and roles). */
export async function resetDb(db = testDb()): Promise<void> {
  const rows = await db.$queryRawUnsafe<{ tablename: string }[]>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
  );
  if (rows.length) await db.$executeRawUnsafe(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
}
