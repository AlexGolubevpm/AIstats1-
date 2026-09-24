import { Sidebar } from "@/components/layout/sidebar";
import { mcpTokenInfo } from "@/server/auth";
import { db } from "@/server/db";
import { freshness } from "@/server/queries/common";
import { isDemo } from "@/server/seed/demo";
import { requireSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await requireSession();
  const [bundles, alerts, deals, fresh, demo, mcp] = await Promise.all([
    db.bundle.findMany({ orderBy: { title: "asc" }, select: { slug: true, title: true, color: true } }),
    db.alert.count({ where: { resolvedAt: null, OR: [{ snoozedUntil: null }, { snoozedUntil: { lt: new Date() } }] } }),
    db.dealPeriod.count({ where: { supersededById: null, status: { in: ["INVOICED", "PARTIAL", "DISPUTED"] }, dueAt: { lt: new Date() } } }),
    freshness(),
    isDemo(db),
    mcpTokenInfo(db),
  ]);
  return (
    <div className="flex min-h-screen">
      <Sidebar bundles={bundles} counts={{ alerts, deals }} mcpConnected={Boolean(mcp || process.env.MCP_TOKEN)}
        freshness={fresh.map((f) => ({ ...f, lastOk: f.lastOk?.toISOString() ?? null }))} />
      <main className="min-w-0 flex-1">
        {demo && (
          <div className="border-b border-warning/30 bg-warning-soft px-6 py-2 text-center text-xs text-warning">
            Демо-данные: цифры сгенерированы. Удалить можно в Настройки → Интеграции.
          </div>
        )}
        <div className="mx-auto flex max-w-[1600px] flex-col gap-4 px-4 py-6 sm:px-6">{children}</div>
      </main>
    </div>
  );
}
