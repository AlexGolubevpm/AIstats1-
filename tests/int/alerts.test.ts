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
    expect(c[0].message).toContain("AdPulsar");
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

  it("4: invisible zone with a revenue forecast at 35% view rate", async () => {
    const c = await RULES.invisibleZone(ctx());
    expect(c).toHaveLength(1);
    expect(c[0].payload.viewRate).toBeCloseTo(0.1);
    expect(c[0].payload.potential).toBeCloseTo(0.2 * 60_000 * 0.35 / 1000);
  });

  it("5: dead zone needs other zones on the site", async () => {
    expect(await RULES.deadZone(ctx())).toHaveLength(0);
    const big = await db.zone.create({ data: { adsgZoneId: 901, siteId: "s1", name: "Slider", format: "SLIDER" } });
    await db.factRevenueZone.create({ data: { date: D1, siteId: "s1", zoneId: big.id, format: "SLIDER", pageLoads: 10_000, impsOwn: 100_000, revenueReported: "500" } });
    const c = await RULES.deadZone(ctx());
    expect(c.map((x) => x.entityKey)).toEqual([`zone:${net.zone.id}`]);
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

  it("8: overdue payment, critical after 30 days", async () => {
    await db.dealPeriod.create({ data: { dealId: net.direct.id, from: D1, to: D2, amountInvoiced: "100", amountPaid: "40",
      status: "PARTIAL", invoiceNo: "INV-1", dueAt: new Date("2026-08-01T00:00:00Z") } });
    const c = await RULES.overduePayment(ctx());
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ level: "CRITICAL", moneyAtRisk: 60 });
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
    db.deal.update({ where: { id: net.direct.id }, data: { endsAt: endsAt ? D(endsAt) : null, status, placementSlug: "welcome_bar" } });
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
    expect(r1.active).toBe(4); // 3 loss geos + invisible zone
    const again = await evaluateAlerts(ctx());
    expect(again.active).toBe(4);
    expect(await db.alert.count()).toBe(4);
    await db.factCost.deleteMany({ where: { siteId: "s3" } });
    const r3 = await evaluateAlerts(ctx());
    expect(r3.resolved).toBe(1);
    expect(await db.alert.count({ where: { resolvedAt: null } })).toBe(3);
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
