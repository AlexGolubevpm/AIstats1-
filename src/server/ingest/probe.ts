// Interactive checks from settings ("Проверить", "Подтянуть сайты"). Same limits as the worker:
// budget, pause, no retries (the user is waiting), and an auth failure pauses the queue.
import type { PrismaClient } from "@/generated/prisma/client";
import type { Config } from "@/server/config";
import { AsgClient, AsgError, type AsgRow } from "./adspyglass/client";
import { MetrikaClient } from "./metrika/client";
import { asgPause, pauseAsg, takeAsgBudget } from "./run";

export type ProbeResult<T> = { ok: true; value: T } | { ok: false; error: string };

export async function withAsg<T>(db: PrismaClient, cfg: Config, fn: (c: AsgClient) => Promise<T>, fetchImpl?: typeof fetch): Promise<ProbeResult<T>> {
  if (!cfg.asg.configured) return { ok: false, error: "ASG_AUTH_EMAIL / ASG_AUTH_TOKEN не заданы" };
  const pause = await asgPause(db);
  if (pause) return { ok: false, error: `AdSpyglass на паузе до ${pause.until.slice(11, 16)} UTC: ${pause.reason}` };
  const client = new AsgClient({ baseUrl: cfg.asg.baseUrl, email: cfg.asg.email, token: cfg.asg.token, minIntervalMs: cfg.asg.minIntervalMs,
    retryDelaysMs: [], takeBudget: () => takeAsgBudget(db, cfg.asg.dailyBudget), fetchImpl });
  try {
    return { ok: true, value: await fn(client) };
  } catch (e) {
    if (e instanceof AsgError && e.pausesQueue) await pauseAsg(db, 60, e.message);
    return { ok: false, error: (e as Error).message };
  }
}

const sum = (rows: AsgRow[], k: keyof AsgRow) => rows.reduce((a, r) => a + Number(r[k] ?? 0), 0);

/** One request per source for yesterday: typos in IDs show up now, not after a day of empty charts. */
export async function checkSite(db: PrismaClient, cfg: Config, siteId: string, day: string, fetchImpl?: typeof fetch) {
  const site = await db.site.findUniqueOrThrow({ where: { id: siteId } });
  const asg: ProbeResult<{ pageLoads: number; revenue: number }> = site.adsgSiteId
    ? await withAsg(db, cfg, async (c) => {
      const rows = await c.report({ from: day, to: day, groupBy: "date", websiteId: site.adsgSiteId! });
      return { pageLoads: sum(rows, "hits"), revenue: sum(rows, "broker_income") };
    }, fetchImpl)
    : { ok: false, error: "ID AdSpyglass не задан" };
  let metrika: ProbeResult<{ uniques: number }>;
  if (!site.metrikaId) metrika = { ok: false, error: "Счётчик не задан" };
  else if (!cfg.metrika.configured) metrika = { ok: false, error: "METRIKA_TOKEN не задан" };
  else {
    try {
      const r = await new MetrikaClient({ token: cfg.metrika.token, fetchImpl }).fetchCounter(site.metrikaId, day, day);
      metrika = { ok: true, value: { uniques: r.rows.reduce((a, x) => a + x.users, 0) } };
    } catch (e) { metrika = { ok: false, error: (e as Error).message }; }
  }
  return { asg, metrika };
}
