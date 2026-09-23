// IngestRun bookkeeping, AdSpyglass pause (circuit breaker) and the daily request budget.
import type { PrismaClient } from "@/generated/prisma/client";
import { AsgError } from "@/server/ingest/adspyglass/client";

export interface RunResult { rows: number; requests?: number; rawKey?: string | null; partial?: string[] }

export async function withIngestRun(
  db: PrismaClient,
  meta: { source: string; job: string; from: string; to: string },
  fn: (runId: string) => Promise<RunResult>,
): Promise<{ id: string; status: string; error?: string }> {
  const run = await db.ingestRun.create({
    data: { source: meta.source, job: meta.job, dateFrom: new Date(`${meta.from}T00:00:00Z`), dateTo: new Date(`${meta.to}T00:00:00Z`), status: "running" },
  });
  try {
    const r = await fn(run.id);
    const status = r.partial?.length ? "partial" : "ok";
    await db.ingestRun.update({ where: { id: run.id }, data: {
      status, rowsUpsert: r.rows, requests: r.requests ?? 0, rawKey: r.rawKey ?? null,
      error: r.partial?.length ? r.partial.join("; ").slice(0, 2000) : null, finishedAt: new Date(),
    } });
    return { id: run.id, status };
  } catch (e) {
    const msg = (e as Error).message;
    await db.ingestRun.update({ where: { id: run.id }, data: { status: "failed", error: msg.slice(0, 2000), finishedAt: new Date(),
      requests: e instanceof AsgErrorWithCount ? e.requests : undefined } });
    if (e instanceof AsgError && e.pausesQueue) await pauseAsg(db, 60, msg);
    return { id: run.id, status: "failed", error: msg };
  }
}

/** Carries the number of requests already sent when a run fails midway. */
export class AsgErrorWithCount extends AsgError {
  constructor(base: AsgError, public requests: number) { super(base.kind, base.message, base.status); }
}

const PAUSE_KEY = "asg_paused_until";

export async function pauseAsg(db: PrismaClient, minutes: number, reason: string): Promise<void> {
  const until = new Date(Date.now() + minutes * 60_000).toISOString();
  await db.appSetting.upsert({ where: { key: PAUSE_KEY }, create: { key: PAUSE_KEY, value: JSON.stringify({ until, reason }) },
    update: { value: JSON.stringify({ until, reason }) } });
}

export async function asgPause(db: PrismaClient): Promise<{ until: string; reason: string } | null> {
  const s = await db.appSetting.findUnique({ where: { key: PAUSE_KEY } });
  if (!s) return null;
  const v = JSON.parse(s.value) as { until: string; reason: string };
  return new Date(v.until).getTime() > Date.now() ? v : null;
}

export async function resumeAsg(db: PrismaClient): Promise<void> {
  await db.appSetting.deleteMany({ where: { key: PAUSE_KEY } });
}

/** Atomically takes one request from today's budget (UTC day). */
export async function takeAsgBudget(db: PrismaClient, limit: number, day = new Date().toISOString().slice(0, 10)): Promise<boolean> {
  const key = `asg_requests:${day}`;
  const rows = await db.$queryRaw<{ value: string }[]>`
    INSERT INTO "AppSetting" (key, value, "updatedAt") VALUES (${key}, '1', now())
    ON CONFLICT (key) DO UPDATE SET value = (("AppSetting".value)::int + 1)::text, "updatedAt" = now()
    WHERE ("AppSetting".value)::int < ${limit}
    RETURNING value`;
  return rows.length > 0;
}

export async function asgRequestsToday(db: PrismaClient, day = new Date().toISOString().slice(0, 10)): Promise<number> {
  const s = await db.appSetting.findUnique({ where: { key: `asg_requests:${day}` } });
  return s ? Number(s.value) : 0;
}
