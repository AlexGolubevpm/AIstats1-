// Job handlers. Thin: each wraps a service in an IngestRun and respects the AdSpyglass pause.
import type { PrismaClient } from "@/generated/prisma/client";
import { addDays } from "@/lib/period";
import type { Config } from "@/server/config";
import { evaluateAlerts } from "@/server/domain/alerts/rules";
import { AsgClient } from "@/server/ingest/adspyglass/client";
import { ingestSiteGeo, ingestSiteTotals, ingestSiteZones, rawGeoKeys, reprocessGeoFromRaw } from "@/server/ingest/adspyglass/ingest";
import { MetrikaClient } from "@/server/ingest/metrika/client";
import { ingestMetrika } from "@/server/ingest/metrika/ingest";
import type { RawStore } from "@/server/ingest/raw-store";
import { AsgError } from "@/server/ingest/adspyglass/client";
import { asgPause, asgRequestsToday, takeAsgBudget, withIngestRun } from "@/server/ingest/run";
import { daysThatFit, defaultWindow, readBackfill, requestsPerDay, saveBackfill, startBackfill, type BackfillMode } from "./backfill";
import { recalcCosts, revshareCosts } from "@/server/services/costs";
import { matchZonesToPlacements } from "@/server/services/inventory";
import { forecastDeals } from "@/server/services/deals";
import { generateHypotheses } from "@/server/services/hypotheses";

export interface JobContext { db: PrismaClient; cfg: Config; raw: RawStore; today?: string; fetchImpl?: typeof fetch }
export interface JobData { from?: string; to?: string; siteId?: string; mode?: BackfillMode }

export const JOB_NAMES = ["asg:totals", "asg:sites", "asg:backfill", "metrika", "derive", "geo:reprocess"] as const;
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
    case "asg:backfill": return defaultWindow(t, data.mode);
    case "metrika": return { from: addDays(t, -1), to: t };
    case "derive": return { from: addDays(t, -4), to: addDays(t, -1) };
    case "geo:reprocess": return { from: addDays(t, -90), to: t };
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
    if (name === "asg:backfill") return runBackfill(ctx, client, w, data);
    return withIngestRun(db, { source: "adspyglass", job: name, ...w }, async (runId) => {
      const deps = { db, client, raw, runId };
      if (name === "asg:totals") {
        const r = await ingestSiteTotals(deps, days(w.from, w.to));
        return { rows: r.rows, requests: client.requests };
      }
      const g = await ingestSiteGeo(deps, days(w.from, w.to), data.siteId);
      const z = await ingestSiteZones(deps, days(w.from, w.to), data.siteId);
      const c = await revshareCosts(db, w.from, w.to, data.siteId); // traffic source revenue → cost
      return { rows: g.rows + z.rows + c, requests: client.requests, partial: [...g.failed, ...(g.skipped ? [g.skipped] : []), ...z.failed] };
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
  if (name === "geo:reprocess") {
    // After an alias was mapped: rewrite country rows from stored raw responses, no API calls.
    return withIngestRun(db, { source: "adspyglass", job: name, ...w }, async () => {
      const keys = await rawGeoKeys(db, raw, w.from, w.to);
      const rows = await reprocessGeoFromRaw(db, raw, keys.filter((k) => !data.siteId || k.siteId === data.siteId));
      const derived = await runJob("derive", ctx, { from: w.from, to: addDays(todayOf(ctx), -1) });
      return { rows, partial: derived.error ? [`derive: ${derived.error}`] : [] };
    });
  }
  // derive: costs → deal forecast → alerts, in that order.
  return withIngestRun(db, { source: "derive", job: name, ...w }, async () => {
    const costs = await recalcCosts(db, w.from, w.to, data.siteId) + await revshareCosts(db, w.from, w.to, data.siteId);
    await matchZonesToPlacements(db); // zones created before a place was added
    const deals = await forecastDeals(db, w.from, w.to);
    const sources = [cfg.asg.configured && "adspyglass", cfg.metrika.configured && "metrika"].filter(Boolean) as string[];
    const alerts = await evaluateAlerts({ db, asOf: todayOf(ctx), configuredSources: sources });
    const hyp = await generateHypotheses(db, todayOf(ctx)); // after the alerts: they feed the proposals
    return { rows: costs + deals + alerts.active + hyp.created + hyp.refreshed };
  });
}

/**
 * Backfill: runs every 30 minutes; with nothing pending it is a no-op without requests. Otherwise
 * it ingests the pending days newest first, as many as fit today's budget minus the nightly
 * reserve, each tick one IngestRun; the budget counter starts over at midnight UTC, so a long
 * window spreads over several days by itself. When the last day lands, `derive` runs over the
 * whole window (costs, deal forecast, alerts). The window is set from the UI (startBackfill) or
 * passed as data for a manual run.
 */
async function runBackfill(ctx: JobContext, client: AsgClient, w: { from: string; to: string }, data: JobData) {
  const { db, cfg, raw } = ctx;
  let state = await readBackfill(db);
  if (data.from && data.to && (!state || state.cancelled || state.from !== data.from || state.to !== data.to)) state = await startBackfill(db, { ...w, siteId: data.siteId, mode: data.mode });
  if (!state || state.cancelled || !state.pending.length) return { status: "skipped", skipped: "бэкфилл: нечего догружать" };
  const mode: BackfillMode = state.mode ?? "full";
  const sites = await db.site.count({ where: { status: "ACTIVE", adsgSiteId: { not: null }, ...(state.siteId ? { id: state.siteId } : {}) } });
  const perDay = requestsPerDay(sites, mode);
  const first = state.pending[0];
  return withIngestRun(db, { source: "adspyglass", job: "asg:backfill", from: first, to: first }, async (runId) => {
    const deps = { db, client, raw, runId };
    const partial: string[] = [];
    let rows = 0, stop: string | null = null, lo = first, hi = first;
    for (const day of [...state!.pending]) {
      const used = await asgRequestsToday(db); // same UTC-day key the budget counter uses
      if (daysThatFit(used, cfg.asg.dailyBudget, cfg.asg.backfillReserve, perDay) < 1) { stop = `бюджет: использовано ${used} из ${cfg.asg.dailyBudget}, резерв ${cfg.asg.backfillReserve}`; break; }
      try {
        if (mode === "totals") {
          rows += (await ingestSiteTotals(deps, [day])).rows; // site totals only; days that already have countries are left alone
        } else {
          const g = await ingestSiteGeo(deps, [day], state!.siteId);
          const z = await ingestSiteZones(deps, [day], state!.siteId);
          rows += g.rows + z.rows + await revshareCosts(db, day, day, state!.siteId);
          partial.push(...g.failed, ...z.failed);
          if (g.skipped) { partial.push(g.skipped); state!.failed.push(day); state!.pending = state!.pending.filter((d) => d !== day); await saveBackfill(db, state!); continue; }
        }
        state!.done.push(day); lo = day < lo ? day : lo; hi = day > hi ? day : hi;
      } catch (e) {
        if (e instanceof AsgError && (e.kind === "budget" || e.pausesQueue)) { stop = e.message; break; }
        state!.failed.push(day); partial.push(`${day}: ${(e as Error).message.slice(0, 120)}`);
      }
      state!.pending = state!.pending.filter((d) => d !== day);
      await saveBackfill(db, state!);
    }
    state!.lastStop = stop ?? undefined;
    await saveBackfill(db, state!);
    await db.ingestRun.update({ where: { id: runId }, data: { dateFrom: new Date(`${lo}T00:00:00Z`), dateTo: new Date(`${hi}T00:00:00Z`) } });
    if (stop && state!.pending.length) {
      partial.push(`продолжит, когда позволит бюджет (${stop}); осталось дней: ${state!.pending.length}`);
    } else if (!state!.pending.length) {
      const d = await runJob("derive", ctx, { from: state!.from, to: state!.to, siteId: state!.siteId });
      if (d.error) partial.push(`derive: ${d.error}`);
    }
    return { rows, requests: client.requests, partial };
  });
}

/** Repeatable schedules (UTC). ASG hourly job is ONE account-level request per day in the window. */
export const SCHEDULES: { name: JobName; pattern: string; queue: "asg" | "main" }[] = [
  { name: "asg:totals", pattern: "5 * * * *", queue: "asg" },
  { name: "asg:sites", pattern: "0 4 * * *", queue: "asg" },
  { name: "asg:backfill", pattern: "*/30 * * * *", queue: "asg" },
  { name: "metrika", pattern: "15 * * * *", queue: "main" },
  { name: "derive", pattern: "45 4 * * *", queue: "main" },
];
