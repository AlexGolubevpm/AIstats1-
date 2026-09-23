import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

// One client per process; reused across hot reloads in dev.
const globalForDb = globalThis as unknown as { prisma?: PrismaClient };

export function createPrisma(url = process.env.DATABASE_URL): PrismaClient {
  if (!url) throw new Error("DATABASE_URL is not set");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}

export const db: PrismaClient = globalForDb.prisma ?? createPrisma();
if (process.env.NODE_ENV !== "production") globalForDb.prisma = db;
