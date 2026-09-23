import { describe, expect, it } from "vitest";

describe("db module", () => {
  it("can be imported without DATABASE_URL (next build collects routes without a database)", async () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const mod = await import("@/server/db");
      expect(mod.db).toBeTruthy();
      expect(() => mod.db.site).toThrow(/DATABASE_URL/);
    } finally {
      if (saved) process.env.DATABASE_URL = saved;
    }
  });
});
