import { beforeEach, describe, expect, it } from "vitest";
import { buildNetwork, D1, D2 } from "@tests/factories/network";
import { RULES, evaluateAlerts, snoozeAlert } from "@/server/domain/alerts/rules";
import { resetDb, testDb } from "./helpers";

const db = testDb();
const asOf = "2026-09-22";
const ctx = (over: Partial<Parameters<typeof evaluateAlerts>[0]> = {}) => ({ db, asOf, configuredSources: [], ...over });
let net: Awaited<ReturnType<typeof buildNetwork>>;

beforeEach(async () => {
  await resetDb();
  net = await buildNetwork(db);
});

describe("alert rules", () => {
  it("country ZZ (no country: source cost, flat deals) is never a loss-making geo", async () => {
    await db.factCost.create({ data: { date: D1, siteId: "s1", countryCode: "ZZ", sourceSlug: "tubecrown", uniquesBought: 0, rateModel: "REVSHARE", rate: "1", cost: "500", origin: "ASG" } });
    const c = await RULES.lossGeo(ctx());
    expect(c.some((x) => x.entityKey.endsWith("country:ZZ"))).toBe(false);
  });

  it("1: loss-making geo — JP on every site, not US", async () => {
    const c = await RULES.lossGeo(ctx());
    expect(c.map((x) => x.entityKey).sort()).toEqual(["site:s1|country:JP", "site:s2|country:JP", "site:s3|country:JP"]);
    expect(c.every((x) => x.level === "CRITICAL" && x.link.includes("by=geo"))).toBe(true);
    expect(c.find((x) => x.siteId === "s1")!.moneyAtRisk).toBeCloseTo(2); // 24 cost − 22 revenue
  });

  it("2: waterfall inversion — 4th-priced network with most of the volume", async () => {
    const extra = await Promise.all(["trafficstars", "clickadu", "exoclick"].map((slug) => db.network.findUniqueOrThrow({ where: { slug } })));
    const rows = extra.map((n, i) => ({ date: D1, siteId: "s2", networkId: n.id, countryCode: "DE", device: "DESKTOP" as const,
      pageLoads: i === 2 ? 60_000 : 5_000, impsOwn: 1_000, impsNetwork: 1_000, revenueReported: i === 2 ? "6" : String(20 - i) }));
    rows.push({ date: D1, siteId: "s2", networkId: net.net.id, countryCode: "DE", device: "DESKTOP", pageLoads: 5_000, impsOwn: 1_000, impsNetwork: 1_000, revenueReported: "30" });
    await db.factRevenueGeo.createMany({ data: rows });
    const c = await RULES.waterfallInversion(ctx());
    expect(c).toHaveLength(1);
    expect(c[0].payload).toMatchObject({ network: "ExoClick", country: "DE", rank: 4 });
    expect(c[0].action).toContain("AdPulsar");
  });

  it("3: discrepancy two days in a row; negative ×2 is critical", async () => {
    const ts = await db.network.findUniqueOrThrow({ where: { slug: "trafficstars" } });
    await db.factRevenueGeo.createMany({ data: [D1, D2].map((date) => ({ date, siteId: "s1", networkId: ts.id, countryCode: "US", device: "DESKTOP" as const,
      pageLoads: 10_000, impsOwn: 6_000, impsNetwork: 13_000, revenueReported: "5" })) });
    const c = await RULES.discrepancyRule(ctx());
    expect(c).toHaveLength(1);
    expect(c[0].level).toBe("CRITICAL");
    // One day only → nothing
    await db.factRevenueGeo.deleteMany({ where: { networkId: ts.id, date: D1 } });
    expect(await RULES.discrepancyRule(ctx())).toHaveLength(0);
  });

  it("4: invisible zone with a revenue forecast at 35% view rate; silent without views, without revenue, under $5 at risk or when the place is sold", async () => {
    // Factory zone: 60 000 imps, 6 000 views, $1.20 → potential $4.20, $3 at risk: below the $5 floor.
    expect(await RULES.invisibleZone(ctx())).toHaveLength(0);
    await db.factRevenueZone.update({ where: { date_zoneId: { date: D1, zoneId: net.zone.id } }, data: { revenueReported: "12" } });
    const c = await RULES.invisibleZone(ctx());
    expect(c).toHaveLength(1);
    expect(c[0].payload.viewRate).toBeCloseTo(0.1);
    expect(c[0].payload.potential).toBeCloseTo(2 * 60_000 * 0.35 / 1000);
    expect(c[0].moneyAtRisk).toBeCloseTo(42 - 12);
    expect(c[0].action).toMatch(/^Поднять зону/);
    expect(c[0].message).not.toMatch(/\$0\.00/);
    // ADOK sent no view rate → views 0: nothing can be said about visibility.
    await db.factRevenueZone.update({ where: { date_zoneId: { date: D1, zoneId: net.zone.id } }, data: { views: 0 } });
    expect(await RULES.invisibleZone(ctx())).toHaveLength(0);
    // No revenue: the estimate would be "$0 instead of $0".
    await db.factRevenueZone.update({ where: { date_zoneId: { date: D1, zoneId: net.zone.id } }, data: { views: 6_000, revenueReported: "0" } });
    expect(await RULES.invisibleZone(ctx())).toHaveLength(0);
    // The zone's place is sold through a deal: zone revenue is not the measure.
    await db.factRevenueZone.update({ where: { date_zoneId: { date: D1, zoneId: net.zone.id } }, data: { revenueReported: "12" } });
    await db.zone.update({ where: { id: net.zone.id }, data: { placementSlug: "under_bar" } });
    await db.dealPlace.create({ data: { dealId: net.direct.id, siteId: "s1", placementSlug: "under_bar" } });
    await db.dealSite.upsert({ where: { dealId_siteId: { dealId: net.direct.id, siteId: "s1" } }, create: { dealId: net.direct.id, siteId: "s1" }, update: {} });
    expect(await RULES.invisibleZone(ctx())).toHaveLength(0);
  });

  it("5: dead zone is judged against the site's zones of the same format, needs volume and fresh data, and prices the loss at the format's CPM", async () => {
    expect(await RULES.deadZone(ctx())).toHaveLength(0);
    // A big slider is another format: a footer banner next to a popunder/slider is not "dead".
    const slider = await db.zone.create({ data: { adsgZoneId: 901, siteId: "s1", name: "Slider", format: "SLIDER" } });
    await db.factRevenueZone.create({ data: { date: D1, siteId: "s1", zoneId: slider.id, format: "SLIDER", pageLoads: 10_000, impsOwn: 1_000_000, revenueReported: "500" } });
    expect(await RULES.deadZone(ctx())).toHaveLength(0);
    // A big banner on the same site: now the factory banner (60 000 imps, $1.20) is 5.7% of banner imps for 0.24% of banner revenue.
    const banner = await db.zone.create({ data: { adsgZoneId: 902, siteId: "s1", name: "Header", format: "BANNER" } });
    await db.factRevenueZone.create({ data: { date: D1, siteId: "s1", zoneId: banner.id, format: "BANNER", pageLoads: 10_000, impsOwn: 1_000_000, revenueReported: "500" } });
    const c = await RULES.deadZone(ctx());
    expect(c.map((x) => x.entityKey)).toEqual([`zone:${net.zone.id}`]);
    expect(c[0].moneyAtRisk).toBeCloseTo((501.2 / 1_060_000) * 60_000 - 1.2, 2); // at the format's CPM minus what it earned
    expect(c[0].action).toMatch(/^Снести зону/);
    // Stale data (last row older than 3 days) or an inactive zone: no alert.
    expect(await RULES.deadZone(ctx({ asOf: "2026-09-30" }))).toHaveLength(0);
    await db.zone.update({ where: { id: net.zone.id }, data: { isActive: false } });
    expect(await RULES.deadZone(ctx())).toHaveLength(0);
  });

  it("6: low fill on large volume", async () => {
    await db.factRevenueZone.update({ where: { date_zoneId: { date: D1, zoneId: net.zone.id } }, data: { pageLoads: 500_000 } });
    const c = await RULES.lowFill(ctx());
    expect(c).toHaveLength(1);
    expect(c[0].payload.fillRate).toBeCloseTo(0.12);
  });

  it("7: closed period without advertiser numbers; entering them clears it", async () => {
    const later = "2026-10-15";
    const c = await RULES.dealNoNumbers(ctx({ asOf: later }));
    expect(c.map((x) => x.entityKey).sort()).toEqual([`deal:${net.direct.id}|2026-09-20`, `deal:${net.viaAsg.id}|2026-09-20`].sort());
    await db.dealPeriod.create({ data: { dealId: net.direct.id, from: D1, to: new Date("2026-09-30T00:00:00Z"), impsReported: 10, amountInvoiced: "5", status: "INVOICED" } });
    expect((await RULES.dealNoNumbers(ctx({ asOf: later }))).map((x) => x.entityKey)).toEqual([`deal:${net.viaAsg.id}|2026-09-20`]);
  });

  it("8: overdue payment, critical after 30 days; nothing owed → nothing", async () => {
    await db.dealPeriod.create({ data: { dealId: net.direct.id, from: D1, to: D2, amountInvoiced: "100", amountPaid: "40",
      status: "PARTIAL", invoiceNo: "INV-1", dueAt: new Date("2026-08-01T00:00:00Z") } });
    await db.dealPeriod.create({ data: { dealId: net.viaAsg.id, from: D1, to: D2, amountInvoiced: "100", amountPaid: "100",
      status: "PARTIAL", invoiceNo: "INV-2", dueAt: new Date("2026-08-01T00:00:00Z") } }); // paid in full, status not yet moved
    const c = await RULES.overduePayment(ctx());
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ level: "CRITICAL", moneyAtRisk: 60 });
    expect(c[0].action).toMatch(/Напомнить/);
  });

  it("11: a source ADOK created with the default share asks for confirmation; setting the share clears it", async () => {
    const { setSourceShare } = await import("@/server/services/settings");
    await db.costSource.create({ data: { slug: "mystery", title: "Mystery", asgName: "Mystery", confirmed: false } });
    await db.factTrafficSource.create({ data: { date: D1, siteId: "s1", sourceSlug: "mystery", pageLoads: 1000, impsOwn: 0, clicks: 0, revenueReported: "40" } });
    const c = await RULES.sourceUnconfigured(ctx());
    expect(c.map((x) => [x.entityKey, x.moneyAtRisk, x.link])).toEqual([["source:mystery", 40, "/settings/costs"]]);
    await setSourceShare(db, "mystery", "0", 7, asOf);
    expect(await RULES.sourceUnconfigured(ctx())).toHaveLength(0);
  });

  it("1: a day with only the site total is not a loss; ZZ source cost is spread over the day's countries by loads", async () => {
    // s1 D1/D2 have JP/US rows. Add a totals-only day with a country cost row: no country cut → ignored.
    const D3 = new Date("2026-09-19T00:00:00Z");
    await db.factRevenueGeo.create({ data: { date: D3, siteId: "s1", networkId: net.net.id, countryCode: "ZZ", device: "UNKNOWN", pageLoads: 10_000, revenueReported: "20" } });
    await db.factCost.create({ data: { date: D3, siteId: "s1", countryCode: "DE", sourceSlug: "tubecrown", uniquesBought: 100, rateModel: "CPM", rate: "1", cost: "50", origin: "RATE" } });
    let c = await RULES.lossGeo(ctx());
    expect(c.some((x) => x.entityKey === "site:s1|country:DE")).toBe(false);
    // ZZ cost on a day with a country cut lands on JP and US by loads (equal loads → half each): US turns red too.
    const base = async (cc: string) => Number((await db.factCost.aggregate({ _sum: { cost: true }, where: { siteId: "s1", countryCode: cc, date: { in: [D1, D2] } } }))._sum.cost ?? 0);
    const usBase = await base("US"), jpBase = await base("JP");
    await db.factCost.create({ data: { date: D1, siteId: "s1", countryCode: "ZZ", sourceSlug: "tubecrown", uniquesBought: 0, rateModel: "REVSHARE", rate: "1", cost: "30", origin: "ASG" } });
    c = await RULES.lossGeo(ctx());
    const us = c.find((x) => x.entityKey === "site:s1|country:US")!;
    expect(us).toBeDefined();
    expect(us.payload.cost).toBeCloseTo(usBase + 15, 2);
    expect(c.find((x) => x.entityKey === "site:s1|country:JP")!.payload.cost).toBeCloseTo(jpBase + 15, 2);
  });

  it("archived sites and system networks never alert; a 'network' with a tiny share has no price rank", async () => {
    await db.site.update({ where: { id: "s1" }, data: { status: "ARCHIVED" } });
    expect((await RULES.lossGeo(ctx())).some((x) => x.siteId === "s1")).toBe(false);
    expect((await RULES.invisibleZone(ctx())).some((x) => x.siteId === "s1")).toBe(false);
    await db.site.update({ where: { id: "s1" }, data: { status: "ACTIVE" } });
    // own_deals (system) with a huge discrepancy: not a network to reconcile with.
    await db.factRevenueGeo.createMany({ data: [D1, D2].map((date) => ({ date, siteId: "s2", networkId: net.own.id, countryCode: "US", device: "DESKTOP" as const,
      pageLoads: 10_000, impsOwn: 6_000, impsNetwork: 20_000, revenueReported: "5" })) });
    expect((await RULES.discrepancyRule(ctx())).some((x) => x.payload.network === "Own deals" || x.title.includes("Own"))).toBe(false);
    // Three "networks" with 100 loads each cannot push a real network to 4th by price.
    const extra = await Promise.all(["trafficstars", "clickadu", "exoclick"].map((slug) => db.network.findUniqueOrThrow({ where: { slug } })));
    await db.factRevenueGeo.createMany({ data: extra.map((x) => ({ date: D1, siteId: "s3", networkId: x.id, countryCode: "DE", device: "DESKTOP" as const,
      pageLoads: 100, impsOwn: 10, impsNetwork: 10, revenueReported: "5" })) });
    await db.factRevenueGeo.create({ data: { date: D1, siteId: "s3", networkId: net.net.id, countryCode: "DE", device: "DESKTOP", pageLoads: 60_000, impsOwn: 1_000, impsNetwork: 1_000, revenueReported: "6" } });
    expect(await RULES.waterfallInversion(ctx())).toHaveLength(0);
  });

  it("9: ingest down for configured sources only", async () => {
    expect(await RULES.ingestDown(ctx())).toHaveLength(0);
    expect(await RULES.ingestDown(ctx({ configuredSources: ["adspyglass"] }))).toHaveLength(1);
    await db.ingestRun.create({ data: { source: "adspyglass", job: "geo", dateFrom: D1, dateTo: D2, status: "ok" } });
    expect(await RULES.ingestDown(ctx({ configuredSources: ["adspyglass"] }))).toHaveLength(0);
  });
});

describe("10: deal ending", () => {
  const D = (s: string) => new Date(`${s}T00:00:00Z`);
  const ending = (endsAt: string | null, status: "ACTIVE" | "PAUSED" | "ENDED" = "ACTIVE") =>
    db.deal.update({ where: { id: net.direct.id }, data: { endsAt: endsAt ? D(endsAt) : null, status, places: { deleteMany: {}, create: [{ siteId: net.s3.id, placementSlug: "welcome_bar" }] } } });
  const only = async () => (await RULES.dealEnding(ctx())).filter((c) => c.payload.dealId === net.direct.id);

  it("warns at 7 days, critical at 3 and 1, critical when ended but still active", async () => {
    await ending("2026-09-29");
    let c = await only();
    expect(c).toHaveLength(1);
    expect([c[0].level, c[0].payload.stage, c[0].payload.daysLeft, c[0].entityKey]).toEqual(["WARNING", 7, 7, `deal:${net.direct.id}|end:2026-09-29`]);
    expect(c[0].title).toContain("через 7 дн.");
    expect(c[0].message).toContain("Acme Ads");
    expect(c[0].message).toContain("Welcome bar");
    expect(c[0].link).toBe(`/deals/${net.direct.id}`);
    await ending("2026-09-25");
    c = await only();
    expect([c[0].level, c[0].payload.stage]).toEqual(["CRITICAL", 3]);
    await ending("2026-09-23");
    c = await only();
    expect([c[0].level, c[0].payload.stage, c[0].payload.daysLeft]).toEqual(["CRITICAL", 1, 1]);
    await ending("2026-09-20");
    c = await only();
    expect([c[0].level, c[0].payload.stage]).toEqual(["CRITICAL", 0]);
    expect(c[0].title).toContain("закончился 2 дн. назад");
  });

  it("nothing for open-ended, far-off or ended deals; money at risk is the last 30 days of revenue", async () => {
    await ending(null);
    expect(await only()).toHaveLength(0);
    await ending("2026-09-30");
    expect(await only()).toHaveLength(0);
    await ending("2026-09-25", "ENDED");
    expect(await only()).toHaveLength(0);
    await ending("2026-09-25", "PAUSED");
    const [c] = await only();
    expect(c.moneyAtRisk).toBe(6); // the direct deal's facts: $3 × 2 days in the factory
  });

  it("evaluateAlerts: a new stage re-surfaces a snoozed alert with a fresh firstSeenAt; same stage keeps it", async () => {
    await ending("2026-09-29");
    await evaluateAlerts(ctx());
    const a = await db.alert.findFirstOrThrow({ where: { rule: "deal_ending" } });
    await snoozeAlert(db, a.id);
    await evaluateAlerts(ctx({ asOf: "2026-09-23" })); // 6 days left: still stage 7
    const same = await db.alert.findUniqueOrThrow({ where: { id: a.id } });
    expect(same.snoozedUntil).not.toBeNull();
    expect(same.firstSeenAt.getTime()).toBe(a.firstSeenAt.getTime());
    await evaluateAlerts(ctx({ asOf: "2026-09-26" })); // 3 days left: stage 3
    const woke = await db.alert.findUniqueOrThrow({ where: { id: a.id } });
    expect(woke.snoozedUntil).toBeNull();
    expect(woke.level).toBe("CRITICAL");
    expect(woke.firstSeenAt.getTime()).toBeGreaterThan(a.firstSeenAt.getTime());
    await ending("2026-10-29"); // prolonged: the old key resolves
    await evaluateAlerts(ctx({ asOf: "2026-09-26" }));
    expect((await db.alert.findUniqueOrThrow({ where: { id: a.id } })).resolvedAt).not.toBeNull();
  });
});

describe("evaluateAlerts", () => {
  it("upserts by key, resolves alerts that disappear", async () => {
    const r1 = await evaluateAlerts(ctx());
    expect(r1.active).toBe(3); // 3 loss geos (the factory banner's $3 at risk is under the invisible-zone floor)
    const again = await evaluateAlerts(ctx());
    expect(again.active).toBe(3);
    expect(await db.alert.count()).toBe(3);
    expect((await db.alert.findFirstOrThrow()).payload).toMatchObject({ action: "Снизить закупку гео или поднять флор." });
    await db.factCost.deleteMany({ where: { siteId: "s3" } });
    const r3 = await evaluateAlerts(ctx());
    expect(r3.resolved).toBe(1);
    expect(await db.alert.count({ where: { resolvedAt: null } })).toBe(2);
    // Yesterday without a per-site country cut: the data rules go silent, but that is missing data, not a fix → nothing resolves.
    await db.factRevenueGeo.deleteMany({ where: { date: D2, countryCode: { not: "ZZ" } } });
    await db.factCost.deleteMany({ where: { siteId: "s2" } });
    const r4 = await evaluateAlerts(ctx());
    expect([r4.resolved, await db.alert.count({ where: { resolvedAt: null } })]).toEqual([0, 2]);
  });

  it("snoozed alert wakes up when money at risk more than doubles", async () => {
    await evaluateAlerts(ctx());
    const a = await db.alert.findFirstOrThrow({ where: { entityKey: "site:s1|country:JP" } });
    await snoozeAlert(db, a.id);
    await evaluateAlerts(ctx());
    expect((await db.alert.findUniqueOrThrow({ where: { id: a.id } })).snoozedUntil).not.toBeNull();
    await db.factCost.updateMany({ where: { siteId: "s1", countryCode: "JP" }, data: { cost: "30" } });
    await evaluateAlerts(ctx());
    expect((await db.alert.findUniqueOrThrow({ where: { id: a.id } })).snoozedUntil).toBeNull();
  });
});

describe("alerts speak about the site when the network cut has no country", () => {
  it("discrepancy and waterfall titles carry no «ZZ»", async () => {
    const extra = await Promise.all(["trafficstars", "clickadu", "exoclick"].map((slug) => db.network.findUniqueOrThrow({ where: { slug } })));
    const rows = extra.map((n, i) => ({ date: D1, siteId: "s2", networkId: n.id, countryCode: "ZZ", device: "UNKNOWN" as const,
      pageLoads: i === 2 ? 60_000 : 5_000, impsOwn: 1_000, impsNetwork: 1_000, revenueReported: i === 2 ? "6" : String(20 - i) }));
    rows.push({ date: D1, siteId: "s2", networkId: net.net.id, countryCode: "ZZ", device: "UNKNOWN", pageLoads: 5_000, impsOwn: 1_000, impsNetwork: 1_000, revenueReported: "30" });
    await db.factRevenueGeo.deleteMany({ where: { siteId: "s2" } });
    await db.factRevenueGeo.createMany({ data: rows });
    for (const date of [D1, D2]) await db.factRevenueGeo.create({ data: { date, siteId: "s3", networkId: net.net.id, countryCode: "ZZ", device: "UNKNOWN", pageLoads: 10_000, impsOwn: 6_000, impsNetwork: 12_600, revenueReported: "5" } });
    await db.factRevenueGeo.deleteMany({ where: { siteId: "s3", countryCode: { not: "ZZ" } } });
    const w = await RULES.waterfallInversion(ctx());
    expect(w.map((c) => c.title)).toEqual(["Инверсия waterfall: ExoClick на two.test"]);
    const d = await RULES.discrepancyRule(ctx());
    expect(d.some((c) => c.title.includes("ZZ"))).toBe(false);
    expect(d.find((c) => c.siteId === "s3")?.title).toMatch(/^Дискрепанси .*: AdPulsar на three.test$/);
    expect(d.find((c) => c.siteId === "s3")?.message).toMatch(/наши показы 12\u00a0000|наши показы 12\u202f000/); // ru-RU grouping (narrow no-break space), two days summed
  });
});
