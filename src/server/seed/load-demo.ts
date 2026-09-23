// Full demo load: generated network → derived costs, deal forecasts, alerts → a few entered
// deal periods (one paid, one invoiced and overdue) so finance and deals pages have content.
import Decimal from "decimal.js";
import type { PrismaClient } from "@/generated/prisma/client";
import { addDays } from "@/lib/period";
import { config } from "@/server/config";
import { closedPeriods } from "@/server/domain/deals";
import { LocalRawStore } from "@/server/ingest/raw-store";
import { runJob } from "@/server/jobs/handlers";
import { calculatePeriodAmount, enterPeriod, recordPayment } from "@/server/services/deals";
import { seedDemo } from "./demo";

export async function loadDemo(db: PrismaClient, opts: { today?: string; days?: number } = {}) {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const r = await seedDemo(db, { today, days: opts.days ?? 60 });
  const ctx = { db, cfg: config({}), raw: new LocalRawStore(process.env.RAW_DIR ?? "/tmp/raw"), today };
  await runJob("derive", ctx, { from: addDays(today, -r.days), to: addDays(today, -1) });

  const deals = await db.deal.findMany({ orderBy: { title: "asc" } });
  for (const [i, deal] of deals.entries()) {
    const closed = closedPeriods({ startsAt: deal.startsAt.toISOString().slice(0, 10), endsAt: null, billingPeriod: "MONTH" }, today);
    const p = closed[closed.length - 1];
    if (!p) continue;
    const imps = deal.paymentBasis === "CPM_ADVERTISER"
      ? Math.round((await calculatePeriodAmount(db, deal.id, p.from, p.to, null)).impsOwn * 1.12) : null; // advertiser counts 12% more
    const calc = await calculatePeriodAmount(db, deal.id, p.from, p.to, imps);
    const id = await enterPeriod(db, deal.id, { ...p, impsReported: imps ?? Math.round(calc.impsOwn * 0.95), amountInvoiced: new Decimal(calc.amount).toFixed(2),
      invoiceNo: `INV-${p.to.slice(0, 7)}-${String(i + 1).padStart(3, "0")}`, dueAt: i === 0 ? addDays(p.to, 30) : addDays(today, -5) });
    if (i === 0) await recordPayment(db, id, { amountPaid: new Decimal(calc.amount).toFixed(2), paidAt: addDays(today, -2) });
  }
  await runJob("derive", ctx, { from: addDays(today, -r.days), to: addDays(today, -1) });
  return r;
}
