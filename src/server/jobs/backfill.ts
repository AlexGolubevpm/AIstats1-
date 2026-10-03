// AdSpyglass backfill state: a window of days ingested newest-first in chunks that fit the daily
// request budget, continued on the next UTC day. docs/architecture/08-backend.md#jobs.
import type { PrismaClient } from "@/generated/prisma/client";
import { addDays } from "@/lib/period";

export const BACKFILL_KEY = "asg_backfill";

export interface BackfillState {
  from: string; to: string; siteId?: string;
  pending: string[]; done: string[]; failed: string[];
  startedAt: string; updatedAt: string; cancelled?: boolean; lastStop?: string;
}

export const daysBetween = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
};

/** Requests one day costs: website + spot for the account, four cuts per site. */
export const requestsPerDay = (sites: number) => 2 + 4 * sites;

/** How many whole days still fit today once the nightly reserve is kept. */
export const daysThatFit = (used: number, budget: number, reserve: number, perDay: number) => Math.max(0, Math.floor((budget - reserve - used) / perDay));

/** Default window: the first day of the previous month up to T-3 (the nightly job covers T-2 and T-1). */
export function defaultWindow(today: string): { from: string; to: string } {
  const t = new Date(`${today}T00:00:00Z`);
  const from = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);
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
export async function startBackfill(db: PrismaClient, w: { from: string; to: string; siteId?: string | null }): Promise<BackfillState> {
  const prev = await readBackfill(db);
  const same = prev && !prev.cancelled && (prev.siteId ?? null) === (w.siteId ?? null);
  const done = same ? prev.done.filter((d) => d >= w.from && d <= w.to) : [];
  const pending = daysBetween(w.from, w.to).filter((d) => !done.includes(d)).sort().reverse();
  const state: BackfillState = { from: w.from, to: w.to, ...(w.siteId ? { siteId: w.siteId } : {}), pending, done, failed: [],
    startedAt: same ? prev.startedAt : new Date().toISOString(), updatedAt: new Date().toISOString() };
  await saveBackfill(db, state);
  return state;
}

export async function cancelBackfill(db: PrismaClient): Promise<void> {
  const s = await readBackfill(db);
  if (s) await saveBackfill(db, { ...s, cancelled: true, pending: [] });
}
