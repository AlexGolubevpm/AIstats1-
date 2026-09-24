// "Отчёт за месяц": site × revenue source × status, plus cost by source. CSV for accounting.
import { db } from "@/server/db";

export async function monthReport(month: string): Promise<string> {
  const from = new Date(`${month}-01T00:00:00Z`);
  const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
  const rows = await db.$queryRaw<{ domain: string; source: string; status: string; amount: string }[]>`
    SELECT s.domain, 'adspyglass' source, CASE WHEN p.month IS NULL THEN 'forecast' ELSE 'confirmed' END status,
           COALESCE(SUM(COALESCE(g."revenueConfirmed", g."revenueReported")), 0)::text amount
      FROM "FactRevenueGeo" g JOIN "Site" s ON s.id = g."siteId" LEFT JOIN "AsgPayout" p ON p.month = ${from}
      WHERE g.date >= ${from} AND g.date < ${to} GROUP BY 1, 2, 3
    UNION ALL
    SELECT s.domain, 'deal:' || a.name || ' / ' || d.title, lower(f."revenueState"::text), SUM(f.revenue)::text
      FROM "FactFixDeal" f JOIN "Deal" d ON d.id = f."dealId" JOIN "Advertiser" a ON a.id = d."advertiserId" JOIN "Site" s ON s.id = f."siteId"
      WHERE d."billedVia" = 'DIRECT' AND f.date >= ${from} AND f.date < ${to} GROUP BY 1, 2, 3
    UNION ALL
    SELECT s.domain, 'cost:' || c."sourceSlug", lower(c.origin::text), (-SUM(c.cost))::text
      FROM "FactCost" c JOIN "Site" s ON s.id = c."siteId" WHERE c.date >= ${from} AND c.date < ${to} GROUP BY 1, 2, 3
    ORDER BY 1, 2, 3`;
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return ["month,site,source,status,amount_usd", ...rows.map((r) => [month, r.domain, r.source, r.status, r.amount].map(esc).join(","))].join("\n");
}
