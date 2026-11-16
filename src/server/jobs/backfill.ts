// AdSpyglass backfill state: a window of days ingested newest-first in chunks that fit the daily
// request budget, continued on the next UTC day. docs/architecture/08-backend.md#jobs.
import type { PrismaClient } from "@/generated/prisma/client";
import { addDays } from "@/lib/period";
import { DEFAULT_PLAN, coreDayRequests, perDayRequests, type AsgPlan } from "@/server/ingest/adspyglass/plan";

export const BACKFILL_KEY = "asg_backfill";

/**
 * full — the planned per-site cuts, zones and cost (plan.ts: 2 + cuts × sites requests a day);
 * core — site money by country, networks and traffic sources + cost (1 + 3 × sites), the first stage after downtime;
 * totals — site totals only (1 request a day).
 */
export type BackfillMode = "full" | "core" | "totals";
export const BACKFILL_MODES: BackfillMode[] = ["full", "core", "totals"];

export interface BackfillState {
  from: string; to: string; siteId?: string; mode: BackfillMode;
  pending: string[]; done: string[]; failed: string[];
  startedAt: string; updatedAt: string; cancelled?: boolean; lastStop?: string;
  /** Two-stage catch-up: stage 1 (core) → stage 2 (full) over the same window. `skip` — days the full stage already has. */
  stage?: 1 | 2; then?: { mode: "full"; skip: string[] };
  /** Who set the window: the owner on the UI / a manual run, or the downtime catch-up. Absent on states saved before 2026-11. */
  origin?: "manual" | "catchup";
}

export const daysBetween = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
};

/** Requests one day costs: website + spot for the account plus the plan's cuts per site; core — website + core cuts per site; totals — one website request. */
export const requestsPerDay = (sites: number, mode: BackfillMode = "full", plan: AsgPlan = DEFAULT_PLAN) =>
  mode === "totals" ? 1 : mode === "core" ? coreDayRequests(plan, sites) : perDayRequests(plan, sites);

/** How many whole days still fit today once the nightly reserve is kept. */
export const daysThatFit = (used: number, budget: number, reserve: number, perDay: number) => Math.max(0, Math.floor((budget - reserve - used) / perDay));

/**
 * Default window up to T-3 (the nightly job covers T-2 and T-1): full cuts from the first day of
 * the current month (analysis starts with the month the cuts exist for); totals from the first
 * day of the previous month (one request a day buys the month-over-month comparison).
 */
export function defaultWindow(today: string, mode: BackfillMode = "full"): { from: string; to: string } {
  const t = new Date(`${today}T00:00:00Z`);
  const from = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - (mode === "totals" ? 1 : 0), 1)).toISOString().slice(0, 10);
  return { from, to: addDays(today, -3) };
}

export async function readBackfill(db: PrismaClient): Promise<BackfillState | null> {
  const s = await db.appSetting.findUnique({ where: { key: BACKFILL_KEY } });
  if (!s) return null;
  try { return JSON.parse(s.value) as BackfillState; } catch { return null; }
}

export async function saveBackfill(db: PrismaClient, state: BackfillState): Promise<void> {
  const value = JSON.stringify({ ...state, updatedAt: new Date().toISOString() });
  await db.appSetting.upsert({ where: { key: BACKFILL_KEY }, create: { key: BACKFILL_KEY, value }, update: { value } });
}

/**
 * Starts a backfill or widens the running one: days already done for the same site filter are
 * kept, everything else in the window is pending, newest first.
 */
export async function startBackfill(db: PrismaClient, w: { from: string; to: string; siteId?: string | null; mode?: BackfillMode; skip?: string[] }): Promise<BackfillState> {
  const prev = await readBackfill(db);
  const mode = w.mode ?? "full";
  const same = prev && !prev.cancelled && (prev.siteId ?? null) === (w.siteId ?? null) && (prev.mode ?? "full") === mode;
  const done = same ? prev.done.filter((d) => d >= w.from && d <= w.to) : [];
  const skip = new Set(w.skip ?? []);
  const pending = daysBetween(w.from, w.to).filter((d) => !done.includes(d) && !skip.has(d)).sort().reverse();
  // Core started from the UI is stage 1 too: the full cuts follow over the same window.
  const staged: Partial<BackfillState> = mode === "core" ? { stage: 1, then: { mode: "full", skip: [] } } : {};
  const state: BackfillState = { from: w.from, to: w.to, ...(w.siteId ? { siteId: w.siteId } : {}), mode, pending, done, failed: [],
    startedAt: same ? prev.startedAt : new Date().toISOString(), updatedAt: new Date().toISOString(), origin: "manual", ...staged };
  await saveBackfill(db, state);
  return state;
}

/**
 * Catch-up after downtime, in two stages: the days of the current month up to yesterday that have no
 * per-site country cut (only ZZ totals, or nothing at all) become a core backfill (sites, networks,
 * money, cost), newest first; when it is done the same window follows with the full cuts. A running
 * backfill is left alone — except a full one saved before the stages existed (no origin: what this
 * function queued then), in the current month: it becomes core for its pending days, then full for them.
 * Returns the days queued, oldest first.
 */
export async function planCatchUp(db: PrismaClient, today: string): Promise<string[]> {
  const prev = await readBackfill(db);
  if (prev && !prev.cancelled && prev.pending.length) {
    if ((prev.mode ?? "full") !== "full" || prev.origin || prev.stage || prev.siteId || prev.from < `${today.slice(0, 7)}-01`) return [];
    const days = [...prev.pending].sort();
    await saveBackfill(db, { ...prev, mode: "core", pending: [...days].reverse(), done: [], failed: [], stage: 1, origin: "catchup",
      then: { mode: "full", skip: prev.done }, lastStop: undefined });
    return days;
  }
  const yesterday = addDays(today, -1);
  const first = `${today.slice(0, 7)}-01`;
  if (yesterday < first) return [];
  const rows = await db.$queryRaw<{ day: string }[]>`
    SELECT DISTINCT to_char(date, 'YYYY-MM-DD') AS day FROM "FactRevenueGeo"
    WHERE date BETWEEN ${first}::date AND ${yesterday}::date AND "countryCode" <> 'ZZ'`;
  const have = new Set(rows.map((r) => r.day));
  const missing = daysBetween(first, yesterday).filter((d) => !have.has(d));
  if (!missing.length) return [];
  await saveBackfill(db, { from: missing[0], to: missing[missing.length - 1], mode: "core", pending: [...missing].reverse(), done: [], failed: [],
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stage: 1, then: { mode: "full", skip: [] }, origin: "catchup" });
  return missing;
}

export async function cancelBackfill(db: PrismaClient): Promise<void> {
  const s = await readBackfill(db);
  if (s) await saveBackfill(db, { ...s, cancelled: true, pending: [] });
}

/**
 * After stage 1 (core) is done: stage 2 — the full cuts over the same window, minus the days the
 * full cuts already have. Returns null when there is no next stage (or nothing left for it).
 */
export async function nextStage(db: PrismaClient, state: BackfillState): Promise<BackfillState | null> {
  if (state.mode !== "core" || !state.then) return null;
  const skip = new Set(state.then.skip);
  const pending = daysBetween(state.from, state.to).filter((d) => !skip.has(d)).reverse();
  if (!pending.length) return null;
  const next: BackfillState = { from: state.from, to: state.to, ...(state.siteId ? { siteId: state.siteId } : {}), mode: state.then.mode, pending,
    done: [...skip].filter((d) => d >= state.from && d <= state.to), failed: [], startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stage: 2, ...(state.origin ? { origin: state.origin } : {}) };
  await saveBackfill(db, next);
  return next;
}
