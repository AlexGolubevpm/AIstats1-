// The ADOK request plan (ADR 0016): which per-site cuts the nightly job pulls, how many past days it
// restates and whether the hourly totals re-read yesterday. The daily request budget is planned
// from these, not hardcoded: every "requests per day" in the app comes from here.
import type { PrismaClient } from "@/generated/prisma/client";

export const PLAN_KEY = "asg_cuts";
export type CutKey = "country" | "network" | "device" | "traffic_source" | "ad_type" | "spot_site" | "hour" | "platform" | "browser" | "popunder_geo" | "source_t12";
export interface CutInfo { key: CutKey; groupBy: string; title: string; what: string; required?: boolean }
/** Per-site cuts in request order. `country` is the base of the geo pages and the alerts: it cannot be turned off. */
export const CUTS: CutInfo[] = [
  { key: "country", groupBy: "country", title: "Страны", what: "гео сайта, расход по странам, алерты по гео", required: true },
  { key: "network", groupBy: "adnetwork_squashed", title: "Сетки", what: "waterfall, rev/1000 loads, дискрепанси по сетке" },
  { key: "device", groupBy: "device", title: "Устройства", what: "вкладка «Девайсы»" },
  { key: "traffic_source", groupBy: "traffic_source", title: "Источники трафика", what: "расход по revshare-источникам, вкладка «Источники»" },
  { key: "ad_type", groupBy: "ad_type", title: "Форматы", what: "загрузки, запросы, показы и fill по формату отдельно (не сумма зон)" },
  { key: "spot_site", groupBy: "spot", title: "Зоны по сайту", what: "зоны фильтром по сайту, а не по домену в названии; без него — один запрос на весь аккаунт" },
  { key: "hour", groupBy: "hour", title: "Часы", what: "профиль дня: загрузки и выручка по часам (вкладка «Часы»)" },
  { key: "platform", groupBy: "platform", title: "Платформы (ОС)", what: "Windows / Android / iOS…: вкладка «Платформы»" },
  { key: "browser", groupBy: "browser", title: "Браузеры", what: "Chrome / Safari…: на той же вкладке; выключен по умолчанию" },
  // ADR 0023: daily history of two fixed slices; they need the filters found by «Проверить фильтры» on /buying. Off by default:
  // the page itself computes any «formats × tiers» slice on request.
  { key: "popunder_geo", groupBy: "country", title: "Попсы по странам", what: "страны с фильтром по зонам попсов, по дням; «Окупаемость закупки» считает срезы сама, по запросу" },
  { key: "source_t12", groupBy: "traffic_source", title: "Источники на T1/T2", what: "источники трафика с фильтром по странам T1/T2, по дням; «Окупаемость закупки» считает срезы сама, по запросу" },
];
/** Account-level requests a day: website totals (the per-site reference) and, unless zones are pulled per site, the account spot cut. */
export const accountRequestsPerDay = (plan: AsgPlan) => 1 + (plan.cuts.spot_site ? 0 : 1);
/** Requests the plan leaves unspent on top of the planned ones: retries and the owner's checks. */
/** Budget meaning "no ceiling" (set as 0 in the UI): far more than a day holds at one request per 5 s. */
export const UNLIMITED = 1_000_000;
export const PLAN_MARGIN = 30;

export interface AsgPlan { cuts: Record<CutKey, boolean>; restateDays: number; hourlyToday: boolean }
export const DEFAULT_PLAN: AsgPlan = {
  cuts: { country: true, network: true, device: true, traffic_source: true, ad_type: true, spot_site: true, hour: true, platform: true, browser: false, popunder_geo: false, source_t12: false },
  restateDays: 3, hourlyToday: true,
};
export const RESTATE_CHOICES = [1, 2, 3] as const;

export function normalizePlan(raw: unknown): AsgPlan {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<AsgPlan>;
  const cuts = { ...DEFAULT_PLAN.cuts };
  for (const c of CUTS) cuts[c.key] = c.required ? true : typeof r.cuts?.[c.key] === "boolean" ? r.cuts[c.key] : DEFAULT_PLAN.cuts[c.key];
  const restateDays = RESTATE_CHOICES.includes(Number(r.restateDays) as 1) ? Number(r.restateDays) : DEFAULT_PLAN.restateDays;
  return { cuts, restateDays, hourlyToday: typeof r.hourlyToday === "boolean" ? r.hourlyToday : DEFAULT_PLAN.hourlyToday };
}

export async function readPlan(db: PrismaClient): Promise<AsgPlan> {
  const row = await db.appSetting.findUnique({ where: { key: PLAN_KEY } });
  if (!row) return DEFAULT_PLAN;
  try { return normalizePlan(JSON.parse(row.value)); } catch { return DEFAULT_PLAN; }
}
export async function savePlan(db: PrismaClient, plan: AsgPlan): Promise<AsgPlan> {
  const p = normalizePlan(plan);
  await db.appSetting.upsert({ where: { key: PLAN_KEY }, create: { key: PLAN_KEY, value: JSON.stringify(p) }, update: { value: JSON.stringify(p) } });
  return p;
}

export const enabledCuts = (plan: AsgPlan): CutInfo[] => CUTS.filter((c) => plan.cuts[c.key]);
/** Cuts of the first stage after downtime: site money by country, networks, traffic sources (cost). Zones and the rest wait for the full stage. */
export const CORE_CUTS: CutKey[] = ["country", "network", "traffic_source"];
/** The plan narrowed to the core cuts (the ones the owner has on); zones are not pulled in core mode. */
export const corePlan = (plan: AsgPlan): AsgPlan => ({ ...plan, cuts: Object.fromEntries(CUTS.map((c) => [c.key, CORE_CUTS.includes(c.key) && plan.cuts[c.key]])) as Record<CutKey, boolean> });
/** Requests one core day costs: the website reference + the core cuts per site. */
export const coreDayRequests = (plan: AsgPlan, sites: number) => 1 + enabledCuts(corePlan(plan)).length * sites;
/** Requests one day of the full per-site ingest costs for N sites. */
export const perDayRequests = (plan: AsgPlan, sites: number) => accountRequestsPerDay(plan) + enabledCuts(plan).length * sites;

export interface PlanCost { perSite: number; account: number; perDay: number; nightly: number; hourly: number; total: number; reserve: number; backfill: number; over: number }
/** What the plan spends of the daily budget: the nightly restate, the hourly totals, the reserve the backfill keeps, what is left for it. */
export function planCost(plan: AsgPlan, sites: number, budget: number): PlanCost {
  const perSite = enabledCuts(plan).length;
  const perDay = perDayRequests(plan, sites);
  const nightly = plan.restateDays * perDay;
  const hourly = plan.hourlyToday ? 24 : 48;
  const total = nightly + hourly;
  const reserve = total + PLAN_MARGIN;
  return { perSite, account: accountRequestsPerDay(plan), perDay, nightly, hourly, total, reserve, backfill: Math.max(0, budget - reserve), over: Math.max(0, total - budget) };
}
