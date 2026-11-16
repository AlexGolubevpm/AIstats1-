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
import { pruneRaw } from "@/server/ingest/raw-retention";
import { AsgError } from "@/server/ingest/adspyglass/client";
import { asgBudget, asgPause, asgRequestsToday, asgSpeed, pauseAsg, slowDownAsg, takeAsgBudget, withIngestRun } from "@/server/ingest/run";
import { daysThatFit, defaultWindow, nextStage, readBackfill, requestsPerDay, saveBackfill, startBackfill, type BackfillMode } from "./backfill";
import { DEFAULT_PLAN, corePlan, planCost, readPlan, type AsgPlan } from "@/server/ingest/adspyglass/plan";
import { recalcCosts, revshareCosts } from "@/server/services/costs";
import { matchZonesToPlacements } from "@/server/services/inventory";
import { forecastDeals } from "@/server/services/deals";
import { generateHypotheses } from "@/server/services/hypotheses";
import { ensureFreshToken, metrikaToken } from "@/server/services/metrika-connection";
import { digestTick } from "@/server/services/telegram";

/** Sources the alert «ингест упал» watches: ADOK from .env, Metrika from the UI connection or .env (ADR 0018). */
export async function configuredSources(db: PrismaClient, cfg: Config): Promise<string[]> {
  return [cfg.asg.configured && "adspyglass", (await metrikaToken(db, cfg)) && "metrika"].filter(Boolean) as string[];
}

export interface JobContext { db: PrismaClient; cfg: Config; raw: RawStore; today?: string; fetchImpl?: typeof fetch; now?: Date }
export interface JobData { from?: string; to?: string; siteId?: string; mode?: BackfillMode }

export const JOB_NAMES = ["asg:totals", "asg:sites", "asg:backfill", "metrika", "derive", "geo:reprocess", "raw:prune", "digest"] as const;
export type JobName = (typeof JOB_NAMES)[number];

const todayOf = (ctx: JobContext) => ctx.today ?? new Date().toISOString().slice(0, 10);
function days(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

async function asgClient(ctx: JobContext): Promise<{ client: AsgClient; parallel: number }> {
  const { asg } = ctx.cfg;
  // Speed set on /settings/integrations («Лимиты AdSpyglass»): pause between request starts and requests in flight.
  const speed = await asgSpeed(ctx.db, asg.minIntervalMs);
  const client = new AsgClient({ baseUrl: asg.baseUrl, email: asg.email, token: asg.token, minIntervalMs: speed.intervalMs, parallel: speed.parallel,
    // the ceiling is read per request: a change on /settings/integrations applies to a run already going
    takeBudget: async () => takeAsgBudget(ctx.db, (await asgBudget(ctx.db, asg.dailyBudget)).limit), fetchImpl: ctx.fetchImpl });
  return { client, parallel: speed.parallel };
}

type IngestOutcome = { status: string; error?: string; skipped?: string };

/** Default windows: the hourly totals look at today (and yesterday when the plan says so); the nightly job at the plan's restate window. */
export function windowFor(name: JobName, ctx: JobContext, data: JobData, plan: AsgPlan = DEFAULT_PLAN): { from: string; to: string } {
  const t = todayOf(ctx);
  if (data.from && data.to) return { from: data.from, to: data.to };
  switch (name) {
    case "asg:totals": return { from: plan.hourlyToday ? t : addDays(t, -1), to: t };
    case "asg:sites": return { from: addDays(t, -plan.restateDays), to: addDays(t, -1) };
    case "asg:backfill": return defaultWindow(t, data.mode);
    case "metrika": return { from: addDays(t, -1), to: t };
    case "derive": return { from: addDays(t, -4), to: addDays(t, -1) };
    case "geo:reprocess": return { from: addDays(t, -90), to: t };
    case "raw:prune": return { from: t, to: t };
    case "digest": return { from: addDays(t, -1), to: addDays(t, -1) };
  }
}

export async function runJob(name: JobName, ctx: JobContext, data: JobData = {}): Promise<{ status: string; error?: string; skipped?: string }> {
  const { db, cfg, raw } = ctx;
  const plan = name.startsWith("asg:") ? await readPlan(db) : DEFAULT_PLAN;
  const w = windowFor(name, ctx, data, plan);
  if (name.startsWith("asg:")) {
    if (!cfg.asg.configured) return { status: "skipped", skipped: "ASG_AUTH_EMAIL / ASG_AUTH_TOKEN не заданы" };
    const pause = await asgPause(db);
    if (pause) return { status: "skipped", skipped: `AdSpyglass на паузе до ${pause.until}: ${pause.reason}` };
    const { client, parallel } = await asgClient(ctx);
    if (name === "asg:backfill") return runBackfill(ctx, client, w, data, plan, parallel);
    return withIngestRun(db, { source: "adspyglass", job: name, ...w }, async (runId) => {
      const deps = { db, client, raw, runId };
      if (name === "asg:totals") {
        const r = await ingestSiteTotals(deps, days(w.from, w.to));
        return { rows: r.rows, requests: client.requests };
      }
      const g = await ingestSiteGeo(deps, days(w.from, w.to), data.siteId, plan);
      const z = await ingestSiteZones(deps, days(w.from, w.to), data.siteId, plan);
      const c = await revshareCosts(db, w.from, w.to, data.siteId); // traffic source revenue → cost
      return { rows: g.rows + z.rows + c, requests: client.requests, partial: [...g.failed, ...(g.skipped ? [g.skipped] : []), ...z.failed] };
    });
  }
  if (name === "metrika") {
    // Renew an expiring OAuth token first; a failed renewal is reported through the run, not swallowed.
    const refreshed = await ensureFreshToken(db, cfg, ctx.fetchImpl).then(() => null, (e: Error) => `обновление токена: ${e.message}`);
    const token = await metrikaToken(db, cfg);
    if (!token) return { status: "skipped", skipped: "Метрика не подключена (Настройки → Интеграции)" };
    const client = new MetrikaClient({ token, fetchImpl: ctx.fetchImpl });
    return withIngestRun(db, { source: "metrika", job: name, ...w }, async (runId) => {
      const r = await ingestMetrika({ db, client, raw, runId }, w.from, w.to, data.siteId);
      return { rows: r.rows, partial: [...(refreshed ? [refreshed] : []), ...r.failed] };
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
  if (name === "digest") {
    // The morning Telegram digest (ADR 0022): sends once a day at the chosen hour, when yesterday is loaded.
    return digestTick(db, cfg, ctx.fetchImpl, ctx.now ?? (ctx.today ? new Date(`${ctx.today}T12:00:00Z`) : new Date()));
  }
  if (name === "raw:prune") {
    // Disk: gzip old plain files, drop superseded runs of final days and everything past 90 days (ADR 0019).
    return withIngestRun(db, { source: "raw", job: name, ...w }, async () => {
      const r = await pruneRaw(raw, todayOf(ctx));
      return { rows: r.deleted, partial: [] };
    });
  }
  // derive: costs → deal forecast → alerts, in that order.
  return withIngestRun(db, { source: "derive", job: name, ...w }, async () => {
    const costs = await recalcCosts(db, w.from, w.to, data.siteId) + await revshareCosts(db, w.from, w.to, data.siteId);
    await matchZonesToPlacements(db); // zones created before a place was added
    const deals = await forecastDeals(db, w.from, w.to);
    const alerts = await evaluateAlerts({ db, asOf: todayOf(ctx), configuredSources: await configuredSources(db, cfg) });
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
async function runBackfill(ctx: JobContext, client: AsgClient, w: { from: string; to: string }, data: JobData, plan: AsgPlan, parallel = 1): Promise<IngestOutcome> {
  const { db, cfg, raw } = ctx;
  let state = await readBackfill(db);
  if (data.from && data.to && (!state || state.cancelled || state.from !== data.from || state.to !== data.to)) state = await startBackfill(db, { ...w, siteId: data.siteId, mode: data.mode });
  if (!state || state.cancelled || !state.pending.length) return { status: "skipped", skipped: "бэкфилл: нечего догружать" };
  const st = state;
  const mode: BackfillMode = st.mode ?? "full";
  const sites = await db.site.count({ where: { status: "ACTIVE", adsgSiteId: { not: null }, ...(st.siteId ? { id: st.siteId } : {}) } });
  const perDay = requestsPerDay(sites, mode, plan);
  // The reserve is what the plan itself needs today (nightly restate + hourly totals + a margin), computed over all sites.
  const allSites = st.siteId ? await db.site.count({ where: { status: "ACTIVE", adsgSiteId: { not: null } } }) : sites;
  const budget = (await asgBudget(db, cfg.asg.dailyBudget)).limit;
  const reserve = planCost(plan, allSites, budget).reserve;
  const first = st.pending[0];
  const requestsBefore = client.requests;
  let advanced = false;
  const res = await withIngestRun(db, { source: "adspyglass", job: "asg:backfill", from: first, to: first }, async (runId) => {
    const deps = { db, client, raw, runId };
    const partial: string[] = [];
    let rows = 0, stop: string | null = null, lo = first, hi = first;
    const finish = async (day: string, ok: boolean) => {
      (ok ? st.done : st.failed).push(day);
      if (ok) { lo = day < lo ? day : lo; hi = day > hi ? day : hi; }
      st.pending = st.pending.filter((d) => d !== day);
      await saveBackfill(db, st);
    };
    /** One day; a budget stop or a queue pause leaves the day pending and is thrown on. */
    const oneDay = async (day: string) => {
      try {
        if (mode === "totals") {
          rows += (await ingestSiteTotals(deps, [day])).rows; // site totals only; days that already have countries are left alone
        } else {
          // core: website + countries, networks, traffic sources per site (money and cost first); full adds the rest and the zones.
          const g = await ingestSiteGeo(deps, [day], st.siteId, mode === "core" ? corePlan(plan) : plan);
          const z = mode === "core" ? { rows: 0, failed: [] as string[] } : await ingestSiteZones(deps, [day], st.siteId, plan);
          rows += g.rows + z.rows + await revshareCosts(db, day, day, st.siteId);
          partial.push(...g.failed, ...z.failed);
          if (g.skipped) { partial.push(g.skipped); return finish(day, false); }
        }
        await finish(day, true);
      } catch (e) {
        if (e instanceof AsgError && (e.kind === "budget" || e.pausesQueue)) {
          if (!stop && e.kind === "rate_limit") { // ADOK says too fast: one step slower and an hour's pause, then the backfill goes on
            const slower = await slowDownAsg(db);
            await pauseAsg(db, 60, `${e.message}${slower ? `; скорость снижена: ${slower}` : ""}`);
          }
          stop = e.message; return;
        }
        partial.push(`${day}: ${(e as Error).message.slice(0, 120)}`);
        await finish(day, false);
      }
    };
    // Newest first, `parallel` days at a time (the client keeps the request starts apart), only as many as the budget fits.
    while (st.pending.length && !stop) {
      const used = await asgRequestsToday(db); // same UTC-day key the budget counter uses
      const fit = daysThatFit(used, budget, reserve, perDay);
      if (fit < 1) { stop = `бюджет: использовано ${used} из ${budget}, резерв плана ${reserve}`; break; }
      await Promise.all(st.pending.slice(0, Math.min(parallel, fit)).map(oneDay));
    }
    st.lastStop = stop ?? undefined;
    await saveBackfill(db, st);
    await db.ingestRun.update({ where: { id: runId }, data: { dateFrom: new Date(`${lo}T00:00:00Z`), dateTo: new Date(`${hi}T00:00:00Z`) } });
    if (stop && st.pending.length) {
      partial.push(`продолжит, когда позволит бюджет (${stop}); осталось дней: ${st.pending.length}`);
    } else if (!st.pending.length) {
      const d = await runJob("derive", ctx, { from: st.from, to: st.to, siteId: st.siteId });
      if (d.error) partial.push(`derive: ${d.error}`);
      // Stage 1 done (sites, networks, money, cost are in): the remaining cuts follow over the same window right away.
      advanced = Boolean(await nextStage(db, st));
    }
    return { rows, requests: client.requests - requestsBefore, partial };
  });
  // Stage 2 runs in the same job (its own IngestRun) instead of waiting for the next half-hourly tick.
  if (advanced && res.status !== "failed") return runBackfill(ctx, client, w, {}, plan, parallel);
  return res;
}

/** Repeatable schedules (UTC). The ASG hourly job is ONE account-level request per day in its window (today, or yesterday + today by the plan). */
export const SCHEDULES: { name: JobName; pattern: string; queue: "asg" | "main" }[] = [
  { name: "asg:totals", pattern: "5 * * * *", queue: "asg" },
  { name: "asg:sites", pattern: "0 4 * * *", queue: "asg" },
  { name: "asg:backfill", pattern: "*/30 * * * *", queue: "asg" },
  { name: "metrika", pattern: "15 * * * *", queue: "main" },
  { name: "derive", pattern: "45 4 * * *", queue: "main" },
  { name: "raw:prune", pattern: "30 5 * * *", queue: "main" },
  { name: "digest", pattern: "0,30 * * * *", queue: "main" },
];
