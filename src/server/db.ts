import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

// One client per process; reused across hot reloads in dev.
const globalForDb = globalThis as unknown as { prisma?: PrismaClient };

export function createPrisma(url = process.env.DATABASE_URL): PrismaClient {
  if (!url) throw new Error("DATABASE_URL is not set");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}

function client(): PrismaClient {
  globalForDb.prisma ??= createPrisma();
  return globalForDb.prisma;
}

/**
 * Created on first use, not on import: `next build` imports route modules without a database
 * (Docker build has no DATABASE_URL), and that must not fail.
 */
export const db: PrismaClient = new Proxy({} as PrismaClient, {
  get(_, prop) {
    const c = client();
    const v = Reflect.get(c, prop, c);
    return typeof v === "function" ? v.bind(c) : v;
  },
});
