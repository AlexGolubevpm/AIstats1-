// Numbers of the morning Telegram digest (ADR 0022): yesterday against the day before it — the network (over sites, never a sum of bundles), bundles, sites, traffic cost by
// source, active alerts and the state of the load. All money is summed in SQL over v_site_geo_daily:
// `revenue_mediated` is everything AdSpyglass reports (deals billed via ADOK are inside it),
// `revenue_direct` — fix deals billed directly, so the two never overlap.
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { addDays } from "@/lib/period";
import type { Change, DigestAlert, DigestBreakdown, DigestData, DigestKind, DigestPlan, DigestTask } from "@/lib/digest";
import { asgPause } from "@/server/ingest/run";

const LIVE = Prisma.sql`(SELECT id FROM "Site" WHERE status <> 'ARCHIVED')`;
const n = (v: unknown) => Number(v ?? 0);

/** Yesterday is loaded for good: the per-site country cut is there and derive ran after the day ended. */
export async function digestReady(db: PrismaClient, day: string): Promise<boolean> {
  const [cut, derived] = await Promise.all([
    db.factRevenueGeo.count({ where: { date: new Date(`${day}T00:00:00Z`), countryCode: { not: "ZZ" } }, take: 1 }),
    db.ingestRun.count({ where: { source: "derive", status: { in: ["ok", "partial"] }, startedAt: { gt: new Date(`${day}T23:59:59Z`) }, dateTo: { gte: new Date(`${day}T00:00:00Z`) } }, take: 1 }),
  ]);
  return cut > 0 && derived > 0;
}

/** Alerts of one rule and level make one group. Money at risk counts what the digest shows: all critical, new warnings. */
export function alertGroups(rows: { level: "CRITICAL" | "WARNING"; rule: string; title: string; message: string; moneyAtRisk: unknown; firstSeenAt: Date; payload: unknown }[], fresh: Date): DigestAlert[] {
  const groups = new Map<string, DigestAlert>();
  for (const a of rows) {
    const isNew = a.firstSeenAt >= fresh, money = Number(a.moneyAtRisk ?? 0);
    const key = `${a.level}|${a.rule}`;
    const g = groups.get(key) ?? { level: a.level, rule: a.rule, count: 0, newCount: 0, moneyAtRisk: 0, action: "", items: [] };
    g.count++;
    if (isNew) g.newCount++;
    if (a.level === "CRITICAL" || isNew) g.moneyAtRisk += money; // display only, like the alerts page header
    const action = (a.payload as { action?: unknown } | null)?.action;
    if (!g.action && typeof action === "string") g.action = action;
    if (g.items.length < MAX_ITEMS) g.items.push({ title: a.title, message: a.message, moneyAtRisk: money, isNew });
    groups.set(key, g);
  }
  // Costliest first: the digest shows what is worth money a day, and the top of the list is what passes the bar.
  for (const g of groups.values()) g.items.sort((x, y) => y.moneyAtRisk - x.moneyAtRisk || Number(y.isNew) - Number(x.isNew));
  const rank = (l: string) => (l === "CRITICAL" ? 0 : 1);
  return [...groups.values()].sort((x, y) => rank(x.level) - rank(y.level) || y.moneyAtRisk - x.moneyAtRisk || y.count - x.count);
}
/** Alerts per group brought into the message; the rest are counted and live on the alerts page. */
export const MAX_ITEMS = 20;

/**
 * The report's own days and the days it compares with: a day against the day before (the digest goes day
 * after day — the owner's call, 16.11), a week Monday–Sunday against the week before, a month against the
 * month before. `day` is the last day of the report.
 */
export function reportPeriod(kind: DigestKind, day: string) {
  if (kind === "week") return { from: addDays(day, -6), to: day, prevFrom: addDays(day, -13), prevTo: addDays(day, -7) };
  if (kind === "month") {
    const from = `${day.slice(0, 7)}-01`, prevTo = addDays(from, -1);
    return { from, to: day, prevFrom: `${prevTo.slice(0, 7)}-01`, prevTo };
  }
  return { from: day, to: day, prevFrom: addDays(day, -1), prevTo: addDays(day, -1) };
}

/** The margin plan of the month `day` falls in: its operating expenses (or the last month's with entries) against the margin so far. */
export async function marginPlan(db: PrismaClient, day: string): Promise<DigestPlan | null> {
  const month = `${day.slice(0, 7)}-01`;
  const opex = (await db.$queryRaw<{ month: Date; amount: number }[]>`
    SELECT e.month, SUM(e.amount)::float8 amount FROM "OpexEntry" e
    WHERE e.month <= ${month}::date AND (e."siteId" IS NULL OR e."siteId" IN ${LIVE})
    GROUP BY e.month ORDER BY e.month DESC LIMIT 1`)[0];
  if (!opex || !(n(opex.amount) > 0)) return null;
  const [m] = await db.$queryRaw<{ margin: number | null }[]>`
    SELECT SUM(g.margin)::float8 margin FROM v_site_geo_daily g WHERE g.date BETWEEN ${month}::date AND ${day}::date AND g.site_id IN ${LIVE}`;
  const own = opex.month.toISOString().slice(0, 10);
  return { month, target: n(opex.amount), margin: n(m?.margin), asOf: day, copiedFrom: own === month ? null : own };
}

type Pair = { cur: number | null; prev: number | null; cur_loads?: number | null; prev_loads?: number | null };
const ch = (r: Pair): Change => ({ cur: n(r.cur), prev: n(r.prev), ...(r.cur_loads !== undefined ? { curLoads: n(r.cur_loads), prevLoads: n(r.prev_loads) } : {}) });

/**
 * What moved and why: the report's days against the days it compares with, summed in SQL over the same
 * views as the digest (live sites only). AdSpyglass money with its page loads (traffic × revenue per 1000
 * loads), by site, bundle, format, network and country; traffic sources (cost and loads); fix deals one by one.
 */
export async function digestBreakdown(db: PrismaClient, kind: DigestKind, day: string): Promise<DigestBreakdown> {
  const { from: curFrom, prevFrom, prevTo } = reportPeriod(kind, day);
  const span = (col: Prisma.Sql) => Prisma.sql`${col} BETWEEN ${prevFrom}::date AND ${day}::date`;
  const c = (col: Prisma.Sql) => Prisma.sql`FILTER (WHERE ${col} >= ${curFrom}::date)`, p = (col: Prisma.Sql) => Prisma.sql`FILTER (WHERE ${col} <= ${prevTo}::date)`;
  const g = Prisma.sql`g.date`, f = Prisma.sql`f.date`, x = Prisma.sql`x.date`;
  const money = (col: Prisma.Sql, d: Prisma.Sql) => Prisma.sql`SUM(${col}) ${c(d)}::float8 cur, SUM(${col}) ${p(d)}::float8 prev`;
  const loads = (col: Prisma.Sql, d: Prisma.Sql) => Prisma.sql`SUM(${col}) ${c(d)}::float8 cur_loads, SUM(${col}) ${p(d)}::float8 prev_loads`;
  const live = (col: Prisma.Sql) => Prisma.sql`${col} IN ${LIVE}`;
  const [[network], sites, bundles, formats, networks, countries, bundleSites, bundleNetworks, formatSites, sources, deals] = await Promise.all([
    db.$queryRaw<Pair[]>`SELECT ${money(Prisma.sql`g.revenue_mediated`, g)}, ${loads(Prisma.sql`g.page_loads`, g)} FROM v_site_geo_daily g WHERE ${span(g)} AND ${live(Prisma.sql`g.site_id`)}`,
    db.$queryRaw<(Pair & { key: string })[]>`SELECT s.domain key, ${money(Prisma.sql`g.revenue_mediated`, g)}, ${loads(Prisma.sql`g.page_loads`, g)}
      FROM v_site_geo_daily g JOIN "Site" s ON s.id = g.site_id WHERE ${span(g)} AND ${live(Prisma.sql`g.site_id`)} GROUP BY s.domain`,
    db.$queryRaw<(Pair & { key: string })[]>`SELECT b.title key, ${money(Prisma.sql`g.revenue_mediated`, g)}, ${loads(Prisma.sql`g.page_loads`, g)}
      FROM v_site_geo_daily g JOIN "BundleSite" bs ON bs."siteId" = g.site_id JOIN "Bundle" b ON b.id = bs."bundleId"
      WHERE ${span(g)} AND ${live(Prisma.sql`g.site_id`)} GROUP BY b.title`,
    db.$queryRaw<(Pair & { key: string })[]>`SELECT f.format key, ${money(Prisma.sql`f.revenue`, f)}, ${loads(Prisma.sql`f.page_loads`, f)}
      FROM v_format_daily f WHERE ${span(f)} AND ${live(Prisma.sql`f.site_id`)} GROUP BY f.format`,
    db.$queryRaw<(Pair & { key: string })[]>`SELECT nw.title key, ${money(Prisma.sql`x."revenueReported"`, x)}
      FROM "FactRevenueNetwork" x JOIN "Network" nw ON nw.id = x."networkId" WHERE ${span(x)} AND ${live(Prisma.sql`x."siteId"`)} GROUP BY nw.title`,
    db.$queryRaw<(Pair & { key: string })[]>`SELECT g.country_code key, ${money(Prisma.sql`g.revenue_mediated`, g)}
      FROM v_site_geo_daily g WHERE ${span(g)} AND ${live(Prisma.sql`g.site_id`)} AND g.country_code NOT IN ('ZZ', 'XX') GROUP BY g.country_code`,
    db.$queryRaw<(Pair & { key: string; part: string })[]>`SELECT b.title key, s.domain part, ${money(Prisma.sql`g.revenue_mediated`, g)}
      FROM v_site_geo_daily g JOIN "Site" s ON s.id = g.site_id JOIN "BundleSite" bs ON bs."siteId" = g.site_id JOIN "Bundle" b ON b.id = bs."bundleId"
      WHERE ${span(g)} AND ${live(Prisma.sql`g.site_id`)} GROUP BY b.title, s.domain`,
    db.$queryRaw<(Pair & { key: string; part: string })[]>`SELECT b.title key, nw.title part, ${money(Prisma.sql`x."revenueReported"`, x)}
      FROM "FactRevenueNetwork" x JOIN "Network" nw ON nw.id = x."networkId" JOIN "BundleSite" bs ON bs."siteId" = x."siteId" JOIN "Bundle" b ON b.id = bs."bundleId"
      WHERE ${span(x)} AND ${live(Prisma.sql`x."siteId"`)} GROUP BY b.title, nw.title`,
    db.$queryRaw<(Pair & { key: string; part: string })[]>`SELECT f.format key, s.domain part, ${money(Prisma.sql`f.revenue`, f)}
      FROM v_format_daily f JOIN "Site" s ON s.id = f.site_id WHERE ${span(f)} AND ${live(Prisma.sql`f.site_id`)} GROUP BY f.format, s.domain`,
    db.$queryRaw<(Pair & { key: string })[]>`SELECT COALESCE(cs.title, k.slug) key, SUM(k.cost) FILTER (WHERE k.date >= ${curFrom}::date)::float8 cur, SUM(k.cost) FILTER (WHERE k.date <= ${prevTo}::date)::float8 prev,
        SUM(k.loads) FILTER (WHERE k.date >= ${curFrom}::date)::float8 cur_loads, SUM(k.loads) FILTER (WHERE k.date <= ${prevTo}::date)::float8 prev_loads
      FROM (SELECT date, "siteId", "sourceSlug" slug, cost, 0::bigint loads FROM "FactCost"
            UNION ALL SELECT date, "siteId", "sourceSlug", 0, "pageLoads" FROM "FactTrafficSource") k
      LEFT JOIN "CostSource" cs ON cs.slug = k.slug
      WHERE k.date BETWEEN ${prevFrom}::date AND ${day}::date AND k."siteId" IN ${LIVE} GROUP BY 1`,
    db.$queryRaw<(Pair & { key: string; status: string; ends_at: Date | null; basis: string })[]>`SELECT d.title key, d.status::text status, d."endsAt" ends_at, d."paymentBasis"::text basis,
        ${money(Prisma.sql`v.revenue`, Prisma.sql`v.date`)}, ${loads(Prisma.sql`v.page_loads`, Prisma.sql`v.date`)}
      FROM v_deal_daily v JOIN "Deal" d ON d.id = v.deal_id
      WHERE v.billed_via = 'DIRECT' AND v.date BETWEEN ${prevFrom}::date AND ${day}::date AND ${live(Prisma.sql`v.site_id`)} GROUP BY d.id, d.title, d.status, d."endsAt", d."paymentBasis"`,
  ]);
  const keyed = (rows: (Pair & { key: string })[]) => rows.map((r) => ({ key: r.key, ...ch(r) }));
  const parted = (rows: (Pair & { key: string; part: string })[]) => rows.map((r) => ({ key: r.key, part: r.part, ...ch(r) }));
  return {
    network: ch(network), sites: keyed(sites), bundles: keyed(bundles), formats: keyed(formats), networks: keyed(networks), countries: keyed(countries),
    bundleSites: parted(bundleSites), bundleNetworks: parted(bundleNetworks), formatSites: parted(formatSites), sources: keyed(sources),
    deals: deals.map((d) => ({ key: d.key, status: d.status, endsAt: d.ends_at ? d.ends_at.toISOString().slice(0, 10) : null, flat: d.basis.startsWith("FLAT"), ...ch(d) })),
  };
}

/** The task board for the digest: open cards in board order (column, position) and the cards done within the report's days. */
export async function digestTasks(db: PrismaClient, kind: DigestKind, day: string): Promise<{ open: DigestTask[]; done: DigestTask[] }> {
  const { from } = reportPeriod(kind, day);
  const select = { title: true, status: true, assignee: true, dueDate: true, priority: true, impactMonth: true, doneAt: true, site: { select: { domain: true } } } as const;
  const iso = (x: Date | null) => (x ? x.toISOString().slice(0, 10) : null);
  const toTask = (x: { title: string; status: string; assignee: string | null; dueDate: Date | null; priority: string; impactMonth: unknown; doneAt: Date | null; site: { domain: string } | null }): DigestTask => ({
    title: x.title, status: x.status as DigestTask["status"], assignee: x.assignee, dueDate: iso(x.dueDate), priority: x.priority as DigestTask["priority"],
    impactMonth: x.impactMonth == null ? null : Number(x.impactMonth), site: x.site?.domain ?? null, doneAt: iso(x.doneAt),
  });
  const [open, done] = await Promise.all([
    db.task.findMany({ where: { status: { not: "DONE" } }, select, orderBy: [{ status: "asc" }, { position: "asc" }] }),
    db.task.findMany({ where: { status: "DONE", doneAt: { gte: new Date(`${from}T00:00:00Z`), lt: new Date(new Date(`${day}T00:00:00Z`).getTime() + 86_400_000) } }, select, orderBy: { doneAt: "asc" } }),
  ]);
  return { open: open.map(toTask), done: done.map(toTask) };
}

export async function digestData(db: PrismaClient, day: string, now = new Date(), kind: DigestKind = "day"): Promise<DigestData> {
  const { from: curFrom, prevFrom, prevTo } = reportPeriod(kind, day);
  const from = prevFrom;
  const fresh = new Date(now.getTime() - 26 * 3_600_000); // "new" = first seen since the previous digest (a day and a margin)
  const win = Prisma.sql`g.date BETWEEN ${from}::date AND ${day}::date AND g.site_id IN ${LIVE}`;
  const cur = Prisma.sql`FILTER (WHERE g.date >= ${curFrom}::date)`, prev = Prisma.sql`FILTER (WHERE g.date <= ${prevTo}::date)`;
  const fwin = Prisma.sql`f.date BETWEEN ${from}::date AND ${day}::date AND f.site_id IN ${LIVE}`;
  const [[net], bundles, sites, costs, overlap, alerts, pause, [cov], lastDerive, ready, plan, breakdown, tasks, formats] = await Promise.all([
    db.$queryRaw<Record<string, number | null>[]>`
      SELECT COUNT(DISTINCT g.date) FILTER (WHERE g.date <= ${prevTo}::date AND (g.revenue <> 0 OR g.page_loads > 0))::int base_days,
        SUM(g.revenue) ${cur}::float8 revenue, SUM(g.revenue_mediated) ${cur}::float8 mediated, SUM(g.revenue_direct) ${cur}::float8 direct,
        SUM(g.cost) ${cur}::float8 cost, SUM(g.margin) ${cur}::float8 margin,
        SUM(g.revenue) ${prev}::float8 p_revenue, SUM(g.cost) ${prev}::float8 p_cost, SUM(g.margin) ${prev}::float8 p_margin
      FROM v_site_geo_daily g WHERE ${win}`,
    db.$queryRaw<{ name: string; revenue: number | null; margin: number | null; p_revenue: number | null }[]>`
      SELECT b.title name, SUM(g.revenue) ${cur}::float8 revenue, SUM(g.margin) ${cur}::float8 margin, SUM(g.revenue) ${prev}::float8 p_revenue
      FROM v_site_geo_daily g JOIN "BundleSite" bs ON bs."siteId" = g.site_id JOIN "Bundle" b ON b.id = bs."bundleId"
      WHERE ${win} GROUP BY b.id, b.title`,
    db.$queryRaw<{ name: string; revenue: number | null; margin: number | null; loads: number | null; p_revenue: number | null; p_loads: number | null }[]>`
      SELECT s.domain name, SUM(g.revenue) ${cur}::float8 revenue, SUM(g.margin) ${cur}::float8 margin, SUM(g.page_loads) ${cur}::float8 loads,
        SUM(g.revenue) ${prev}::float8 p_revenue, SUM(g.page_loads) ${prev}::float8 p_loads
      FROM v_site_geo_daily g JOIN "Site" s ON s.id = g.site_id WHERE ${win} GROUP BY s.id, s.domain`,
    db.$queryRaw<{ title: string; cost: number }[]>`
      SELECT COALESCE(cs.title, c."sourceSlug") title, SUM(c.cost)::float8 cost FROM "FactCost" c LEFT JOIN "CostSource" cs ON cs.slug = c."sourceSlug"
      WHERE c.date BETWEEN ${curFrom}::date AND ${day}::date AND c."siteId" IN ${LIVE} GROUP BY 1`,
    db.$queryRaw<{ n: number }[]>`SELECT COUNT(*)::int n FROM (SELECT "siteId" FROM "BundleSite" WHERE "siteId" IN ${LIVE} GROUP BY 1 HAVING COUNT(*) > 1) x`,
    // Every active alert, new and costly first; grouped by rule and level below.
    db.alert.findMany({ where: { resolvedAt: null, OR: [{ snoozedUntil: null }, { snoozedUntil: { lt: now } }] },
      select: { level: true, rule: true, title: true, message: true, moneyAtRisk: true, firstSeenAt: true, payload: true },
      orderBy: [{ moneyAtRisk: "desc" }, { title: "asc" }] }),
    asgPause(db),
    // Sites with AdSpyglass revenue yesterday but no traffic-source cut: their cost is 0 because it was not loaded.
    db.$queryRaw<{ missing: number; sites: number }[]>`
      SELECT COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM "FactTrafficSource" f WHERE f.date = x.date AND f."siteId" = x.site_id))::int missing, COUNT(*)::int sites
      FROM (SELECT g.date, g.site_id FROM v_site_geo_daily g WHERE g.date = ${day}::date AND g.site_id IN ${LIVE} GROUP BY 1, 2 HAVING SUM(g.revenue_mediated) > 0) x`,
    db.ingestRun.findFirst({ where: { source: "derive", status: { not: "running" } }, orderBy: { startedAt: "desc" } }),
    digestReady(db, day),
    marginPlan(db, day),
    digestBreakdown(db, kind, day),
    digestTasks(db, kind, day),
    // AdSpyglass revenue by format (v_format_daily: the ad_type cut, zones where it is missing) — own and fix deals are not in it.
    db.$queryRaw<{ format: string; revenue: number | null; p_revenue: number | null }[]>`
      SELECT f.format, SUM(f.revenue) FILTER (WHERE f.date >= ${curFrom}::date)::float8 revenue, SUM(f.revenue) FILTER (WHERE f.date <= ${prevTo}::date)::float8 p_revenue
      FROM v_format_daily f WHERE ${fwin} GROUP BY f.format`,
  ]);
  const base = n(net?.base_days);
  const avg = (v: number | null | undefined) => (base ? n(v) : 0); // the day before as it is
  const health: string[] = [];
  if (pause) health.push(`AdSpyglass на паузе до ${pause.until.slice(11, 16)} UTC: ${pause.reason.slice(0, 80)}`);
  if (n(cov?.missing) > 0) health.push(`Расход не загружен у ${cov!.missing} из ${cov!.sites} сайтов — маржа завышена`);
  if (lastDerive?.status === "failed") health.push("Ночной пересчёт (derive) упал — дилы и алерты не обновлены");
  return {
    day, kind, from: curFrom, plan, breakdown, tasks, baseDays: base,
    total: { revenue: n(net?.revenue), mediated: n(net?.mediated), direct: n(net?.direct), cost: n(net?.cost), margin: n(net?.margin) },
    prev: { revenue: avg(net?.p_revenue), cost: avg(net?.p_cost), margin: avg(net?.p_margin) },
    bundles: bundles.map((b) => ({ name: b.name, revenue: n(b.revenue), margin: n(b.margin), prevRevenue: avg(b.p_revenue) })),
    bundlesOverlap: n(overlap[0]?.n) > 0,
    formats: formats.map((f) => ({ format: f.format, revenue: n(f.revenue), prevRevenue: avg(f.p_revenue) })),
    sites: sites.map((s) => ({ name: s.name, revenue: n(s.revenue), margin: n(s.margin), prevRevenue: avg(s.p_revenue), pageLoads: n(s.loads), prevLoads: avg(s.p_loads) })),
    costs: costs.map((c) => ({ title: c.title, cost: n(c.cost) })),
    alerts: alertGroups(alerts, fresh),
    health, incomplete: !ready,
  };
}
