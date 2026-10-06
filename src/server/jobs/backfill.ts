// AdSpyglass backfill state: a window of days ingested newest-first in chunks that fit the daily
// request budget, continued on the next UTC day. docs/architecture/08-backend.md#jobs.
import type { PrismaClient } from "@/generated/prisma/client";
import { addDays } from "@/lib/period";

export const BACKFILL_KEY = "asg_backfill";

/** full — every per-site cut, zones and cost (2 + 4 × sites requests a day); totals — site totals only (1 request a day). */
export type BackfillMode = "full" | "totals";

export interface BackfillState {
  from: string; to: string; siteId?: string; mode: BackfillMode;
  pending: string[]; done: string[]; failed: string[];
  startedAt: string; updatedAt: string; cancelled?: boolean; lastStop?: string;
}

export const daysBetween = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
};

/** Requests one day costs: website + spot for the account, four cuts per site; totals mode is one website request. */
export const requestsPerDay = (sites: number, mode: BackfillMode = "full") => (mode === "totals" ? 1 : 2 + 4 * sites);

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
export async function startBackfill(db: PrismaClient, w: { from: string; to: string; siteId?: string | null; mode?: BackfillMode }): Promise<BackfillState> {
  const prev = await readBackfill(db);
  const mode = w.mode ?? "full";
  const same = prev && !prev.cancelled && (prev.siteId ?? null) === (w.siteId ?? null) && (prev.mode ?? "full") === mode;
  const done = same ? prev.done.filter((d) => d >= w.from && d <= w.to) : [];
  const pending = daysBetween(w.from, w.to).filter((d) => !done.includes(d)).sort().reverse();
  const state: BackfillState = { from: w.from, to: w.to, ...(w.siteId ? { siteId: w.siteId } : {}), mode, pending, done, failed: [],
    startedAt: same ? prev.startedAt : new Date().toISOString(), updatedAt: new Date().toISOString() };
  await saveBackfill(db, state);
  return state;
}

/**
 * Catch-up after downtime: the days of the current month up to yesterday that have no per-site
 * country cut (only ZZ totals, or nothing at all) become a full-mode backfill, newest first, unless
 * a backfill is already running. Returns the days queued, oldest first.
 */
export async function planCatchUp(db: PrismaClient, today: string): Promise<string[]> {
  const prev = await readBackfill(db);
  if (prev && !prev.cancelled && prev.pending.length) return [];
  const yesterday = addDays(today, -1);
  const first = `${today.slice(0, 7)}-01`;
  if (yesterday < first) return [];
  const rows = await db.$queryRaw<{ day: string }[]>`
    SELECT DISTINCT to_char(date, 'YYYY-MM-DD') AS day FROM "FactRevenueGeo"
    WHERE date BETWEEN ${first}::date AND ${yesterday}::date AND "countryCode" <> 'ZZ'`;
  const have = new Set(rows.map((r) => r.day));
  const missing = daysBetween(first, yesterday).filter((d) => !have.has(d));
  if (!missing.length) return [];
  await saveBackfill(db, { from: missing[0], to: missing[missing.length - 1], mode: "full", pending: [...missing].reverse(), done: [], failed: [],
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  return missing;
}

export async function cancelBackfill(db: PrismaClient): Promise<void> {
  const s = await readBackfill(db);
  if (s) await saveBackfill(db, { ...s, cancelled: true, pending: [] });
}
