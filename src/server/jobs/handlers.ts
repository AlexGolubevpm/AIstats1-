// Job handlers. Thin: each wraps a service in an IngestRun and respects the AdSpyglass pause.
import type { PrismaClient } from "@/generated/prisma/client";
import { addDays } from "@/lib/period";
import type { Config } from "@/server/config";
import { evaluateAlerts } from "@/server/domain/alerts/rules";
import { AsgClient } from "@/server/ingest/adspyglass/client";
import { ingestSiteGeo, ingestSiteTotals, ingestSiteZones } from "@/server/ingest/adspyglass/ingest";
import { MetrikaClient } from "@/server/ingest/metrika/client";
import { ingestMetrika } from "@/server/ingest/metrika/ingest";
import type { RawStore } from "@/server/ingest/raw-store";
import { asgPause, takeAsgBudget, withIngestRun } from "@/server/ingest/run";
import { recalcCosts } from "@/server/services/costs";
import { forecastDeals } from "@/server/services/deals";

export interface JobContext { db: PrismaClient; cfg: Config; raw: RawStore; today?: string; fetchImpl?: typeof fetch }
export interface JobData { from?: string; to?: string; siteId?: string }

export const JOB_NAMES = ["asg:totals", "asg:sites", "metrika", "derive"] as const;
export type JobName = (typeof JOB_NAMES)[number];

const todayOf = (ctx: JobContext) => ctx.today ?? new Date().toISOString().slice(0, 10);
function days(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

function asgClient(ctx: JobContext): AsgClient {
  const { asg } = ctx.cfg;
  return new AsgClient({ baseUrl: asg.baseUrl, email: asg.email, token: asg.token, minIntervalMs: asg.minIntervalMs,
    takeBudget: () => takeAsgBudget(ctx.db, asg.dailyBudget), fetchImpl: ctx.fetchImpl });
}

/** Default windows: hourly jobs look at yesterday + today; nightly ones at the restate window. */
export function windowFor(name: JobName, ctx: JobContext, data: JobData): { from: string; to: string } {
  const t = todayOf(ctx);
  if (data.from && data.to) return { from: data.from, to: data.to };
  switch (name) {
    case "asg:totals": return { from: addDays(t, -1), to: t };
    case "asg:sites": return { from: addDays(t, -ctx.cfg.asg.restateDays), to: addDays(t, -1) };
    case "metrika": return { from: addDays(t, -1), to: t };
    case "derive": return { from: addDays(t, -4), to: addDays(t, -1) };
  }
}

export async function runJob(name: JobName, ctx: JobContext, data: JobData = {}): Promise<{ status: string; error?: string; skipped?: string }> {
  const { db, cfg, raw } = ctx;
  const w = windowFor(name, ctx, data);
  if (name.startsWith("asg:")) {
    if (!cfg.asg.configured) return { status: "skipped", skipped: "ASG_AUTH_EMAIL / ASG_AUTH_TOKEN не заданы" };
    const pause = await asgPause(db);
    if (pause) return { status: "skipped", skipped: `AdSpyglass на паузе до ${pause.until}: ${pause.reason}` };
    const client = asgClient(ctx);
    return withIngestRun(db, { source: "adspyglass", job: name, ...w }, async (runId) => {
      const deps = { db, client, raw, runId };
      if (name === "asg:totals") {
        const r = await ingestSiteTotals(deps, days(w.from, w.to));
        return { rows: r.rows, requests: client.requests };
      }
      const g = await ingestSiteGeo(deps, days(w.from, w.to), data.siteId);
      const z = await ingestSiteZones(deps, days(w.from, w.to), data.siteId);
      return { rows: g.rows + z.rows, requests: client.requests, partial: [...g.failed, ...z.failed] };
    });
  }
  if (name === "metrika") {
    if (!cfg.metrika.configured) return { status: "skipped", skipped: "METRIKA_TOKEN не задан" };
    const client = new MetrikaClient({ token: cfg.metrika.token, fetchImpl: ctx.fetchImpl });
    return withIngestRun(db, { source: "metrika", job: name, ...w }, async (runId) => {
      const r = await ingestMetrika({ db, client, raw, runId }, w.from, w.to, data.siteId);
      return { rows: r.rows, partial: r.failed };
    });
  }
  // derive: costs → deal forecast → alerts, in that order.
  return withIngestRun(db, { source: "derive", job: name, ...w }, async () => {
    const costs = await recalcCosts(db, w.from, w.to, data.siteId);
    const deals = await forecastDeals(db, w.from, w.to);
    const sources = [cfg.asg.configured && "adspyglass", cfg.metrika.configured && "metrika"].filter(Boolean) as string[];
    const alerts = await evaluateAlerts({ db, asOf: todayOf(ctx), configuredSources: sources });
    return { rows: costs + deals + alerts.active };
  });
}

/** Repeatable schedules (UTC). ASG hourly job is ONE account-level request per day in the window. */
export const SCHEDULES: { name: JobName; pattern: string; queue: "asg" | "main" }[] = [
  { name: "asg:totals", pattern: "5 * * * *", queue: "asg" },
  { name: "asg:sites", pattern: "0 4 * * *", queue: "asg" },
  { name: "metrika", pattern: "15 * * * *", queue: "main" },
  { name: "derive", pattern: "45 4 * * *", queue: "main" },
];
