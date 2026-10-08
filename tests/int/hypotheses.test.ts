import { beforeEach, describe, expect, it } from "vitest";
import { buildNetwork, D1, D2 } from "@tests/factories/network";
import { collectCandidates, hypothesesList, hypothesisCounts, topHypotheses } from "@/server/queries/hypotheses";
import { createHypothesis, generateHypotheses, hypothesisFromAlert, measureMetric, setHypothesisStatus } from "@/server/services/hypotheses";
import { RuleError } from "@/server/domain/errors";
import { resetDb, testDb } from "./helpers";

const db = testDb();
let net: Awaited<ReturnType<typeof buildNetwork>>;
const TODAY = "2026-09-22";
const alertData = { rule: "loss_geo", entityKey: "site:s1|country:JP", level: "CRITICAL" as const, title: "Убыточное гео JP на one.test",
  message: "За 7 дней выручка $20.00 при расходе $24.00 (ROMI -16.7%).", link: "/sites/one.test?by=geo", siteId: "s1", moneyAtRisk: "4", payload: { action: "Снизить закупку гео или поднять флор." } };

beforeEach(async () => { await resetDb(); net = await buildNetwork(db); });

describe("candidates over the factory network", () => {
  it("collects alerts and rules: the invisible zone, free places and the alert's hypothesis", async () => {
    const a = await db.alert.create({ data: alertData });
    const list = await collectCandidates(TODAY);
    const keys = list.map((c) => `${c.ruleKey}|${c.objectKey}`);
    expect(keys).toContain(`loss_geo|site:s1|country:JP`);
    expect(list.find((c) => c.ruleKey === "loss_geo")).toMatchObject({ source: "ALERT", alertId: a.id, siteId: "s1", countryCode: "JP" });
    expect(keys).toContain(`invisible_zone|zone:${net.zone.id}`); // 6 000 views of 60 000 impressions over the week
    expect(keys.some((k) => k.startsWith("free_places|"))).toBe(true); // every factory site has free places
    expect(list[0].level).toBe("CRITICAL");
    expect(list.every((c) => c.hypothesis && c.title && c.link)).toBe(true);
  });

  it("site below bundle: a third JAV site earning a tenth per load shows up with the bundle median as evidence", async () => {
    const s4 = await db.site.create({ data: { id: "s4", domain: "four.test", title: "Four", adsgSiteId: 4 } });
    await db.bundleSite.create({ data: { bundleId: net.jav.id, siteId: s4.id } });
    for (const date of [D1, D2]) await db.factRevenueGeo.create({ data: { date, siteId: s4.id, networkId: net.net.id, countryCode: "JP", device: "DESKTOP", pageLoads: 60_000, impsOwn: 50_000, revenueReported: "6" } });
    // s1 and s2 earn $1 per 1000 loads (factory), s4 $0.1: well under 75% of the median.
    for (const date of [D1, D2]) for (const siteId of ["s1", "s2"]) await db.factRevenueGeo.updateMany({ where: { date, siteId, countryCode: "JP" }, data: { pageLoads: 30_000 } });
    const list = await collectCandidates(TODAY);
    const h = list.find((c) => c.ruleKey === "site_below_bundle" && c.siteId === "s4");
    expect(h).toBeDefined();
    expect(h).toMatchObject({ bundleId: net.jav.id, scope: "site", metric: "rev_per_1k" });
    expect(Number(h!.evidence.revPer1k)).toBeCloseTo(0.1, 3);
  });
});

describe("generateHypotheses", () => {
  it("stores proposals once, refreshes them on the next run, expires the ones that vanish and brings them back", async () => {
    const first = await generateHypotheses(db, TODAY);
    expect(first.created).toBeGreaterThan(0);
    expect(first.refreshed).toBe(0);
    const n1 = await db.hypothesis.count();
    const second = await generateHypotheses(db, TODAY);
    expect(second).toMatchObject({ created: 0, refreshed: n1, expired: 0 });
    expect(await db.hypothesis.count()).toBe(n1);
    // The zone stops being invisible: its proposal expires; when the data comes back, it is proposed again.
    await db.factRevenueZone.updateMany({ where: { zoneId: net.zone.id }, data: { views: 50_000 } });
    await generateHypotheses(db, TODAY);
    const zone = await db.hypothesis.findUniqueOrThrow({ where: { ruleKey_objectKey: { ruleKey: "invisible_zone", objectKey: `zone:${net.zone.id}` } } });
    expect(zone.status).toBe("EXPIRED");
    await db.factRevenueZone.updateMany({ where: { zoneId: net.zone.id }, data: { views: 6_000 } });
    await generateHypotheses(db, TODAY);
    expect((await db.hypothesis.findUniqueOrThrow({ where: { id: zone.id } })).status).toBe("PROPOSED");
  });

  it("a rejected proposal stays quiet for 30 days, then returns; an accepted one keeps its text but gets fresh numbers", async () => {
    await generateHypotheses(db, TODAY);
    const zone = await db.hypothesis.findUniqueOrThrow({ where: { ruleKey_objectKey: { ruleKey: "invisible_zone", objectKey: `zone:${net.zone.id}` } } });
    await setHypothesisStatus(db, zone.id, "REJECTED", "баннер и так ниже фолда по дизайну", TODAY);
    await generateHypotheses(db, TODAY);
    expect((await db.hypothesis.findUniqueOrThrow({ where: { id: zone.id } })).status).toBe("REJECTED");
    await db.hypothesis.update({ where: { id: zone.id }, data: { closedAt: new Date(Date.now() - 31 * 86_400_000) } });
    await generateHypotheses(db, TODAY);
    expect((await db.hypothesis.findUniqueOrThrow({ where: { id: zone.id } })).status).toBe("PROPOSED");
    await setHypothesisStatus(db, zone.id, "ACCEPTED", null, TODAY);
    await db.hypothesis.update({ where: { id: zone.id }, data: { hypothesis: "моя формулировка" } });
    await db.factRevenueZone.updateMany({ where: { zoneId: net.zone.id }, data: { revenueReported: "2.4" } });
    await generateHypotheses(db, TODAY);
    const after = await db.hypothesis.findUniqueOrThrow({ where: { id: zone.id } });
    expect(after.status).toBe("ACCEPTED");
    expect(after.hypothesis).toBe("моя формулировка");
    expect((after.evidence as { revenue: number }).revenue).toBeCloseTo(2.4, 2); // the factory zone has one day of facts, now at $2.40
  });

  it("an alert is one hypothesis whether the night or the button made it; the alert that is already there is not duplicated", async () => {
    const a = await db.alert.create({ data: alertData });
    const id = await hypothesisFromAlert(db, a.id, TODAY);
    expect(await hypothesisFromAlert(db, a.id, TODAY)).toBe(id);
    await generateHypotheses(db, TODAY);
    expect(await db.hypothesis.count({ where: { ruleKey: "loss_geo" } })).toBe(1);
    expect((await db.hypothesis.findUniqueOrThrow({ where: { id } })).source).toBe("ALERT");
  });
});

describe("own hypotheses and statuses", () => {
  it("needs a bundle or a site and a real sentence; the site must belong to the chosen bundle", async () => {
    await expect(createHypothesis(db, { title: "x", hypothesis: "если поднять флор, то вырастет" })).rejects.toBeInstanceOf(RuleError);
    await expect(createHypothesis(db, { title: "x", hypothesis: "коротко", siteId: "s1" })).rejects.toMatchObject({ field: "hypothesis" });
    await expect(createHypothesis(db, { title: "x", hypothesis: "если поднять флор, то вырастет", siteId: "s3", bundleId: net.jav.id })).rejects.toMatchObject({ field: "bundleId" }); // s3 is not in JAV
    const id = await createHypothesis(db, { title: "Флор баннеров", hypothesis: "Если поднять флор баннеров до $1, то rev/1k вырастет", siteId: "s1", bundleId: net.jav.id, format: "BANNER", countryCode: "jp", impactMonth: "120", metric: "rev_per_1k" });
    const h = await db.hypothesis.findUniqueOrThrow({ where: { id } });
    expect(h).toMatchObject({ source: "MANUAL", status: "PROPOSED", scope: "format", format: "BANNER", countryCode: "JP", link: "/sites/one.test", metric: "rev_per_1k" });
    expect(Number(h.impactMonth)).toBe(120);
    expect(await db.auditLog.count({ where: { entity: "Hypothesis", entityId: id } })).toBe(1);
  });

  it("accepting freezes the baseline over the 14 days before; finishing measures the result; transitions are checked", async () => {
    // Site s1 earns $1 per 1000 loads on the factory's two days (09-20, 09-21).
    const id = await createHypothesis(db, { title: "Флор", hypothesis: "Если поднять флор, то rev/1k вырастет", siteId: "s1", metric: "rev_per_1k" });
    await expect(setHypothesisStatus(db, id, "DONE", null, TODAY)).rejects.toBeInstanceOf(RuleError); // not accepted yet
    // Two days of data are under the 7-day minimum: the baseline stays empty, the acceptance still happens.
    await setHypothesisStatus(db, id, "ACCEPTED", null, TODAY);
    let h = await db.hypothesis.findUniqueOrThrow({ where: { id } });
    expect(h.status).toBe("ACCEPTED"); expect(h.acceptedAt).not.toBeNull(); expect(h.baseline).toBeNull();
    // Fill 14 days of history at $1/1k, accept again from scratch, improve to $2/1k and finish.
    await setHypothesisStatus(db, id, "REJECTED", null, TODAY);
    await setHypothesisStatus(db, id, "PROPOSED", null, TODAY);
    for (let i = 2; i <= 15; i++) await db.factRevenueGeo.create({ data: { date: new Date(`2026-09-${String(22 - i).padStart(2, "0")}T00:00:00Z`), siteId: "s1", networkId: net.net.id, countryCode: "US", device: "DESKTOP", pageLoads: 10_000, revenueReported: "10" } }).catch(() => null);
    await setHypothesisStatus(db, id, "ACCEPTED", null, TODAY);
    h = await db.hypothesis.findUniqueOrThrow({ where: { id } });
    expect(Number(h.baseline)).toBeGreaterThan(1); expect(Number(h.baseline)).toBeLessThan(1.1); // $1/1k plus the factory's two richer days
    const later = "2026-10-10";
    for (let day = 1; day <= 9; day++) await db.factRevenueGeo.create({ data: { date: new Date(`2026-10-0${day}T00:00:00Z`), siteId: "s1", networkId: net.net.id, countryCode: "US", device: "DESKTOP", pageLoads: 10_000, revenueReported: "20" } });
    await db.hypothesis.update({ where: { id }, data: { acceptedAt: new Date("2026-09-25T00:00:00Z") } });
    await setHypothesisStatus(db, id, "DONE", "подняли флор", later);
    h = await db.hypothesis.findUniqueOrThrow({ where: { id } });
    expect(h.status).toBe("DONE"); expect(h.resultNote).toBe("подняли флор");
    expect(Number(h.result)).toBeCloseTo(2, 3);
    expect(await db.auditLog.count({ where: { entity: "Hypothesis", entityId: id, field: "status" } })).toBe(6);
  });

  it("measureMetric reads the right slice: zone view rate, network rev/1k, format revenue, source cost per 1k, bundle cost share", async () => {
    const base = { id: "x", metric: null, siteId: null, bundleId: null, countryCode: null, zoneId: null, networkId: null, format: null, sourceSlug: null, dealId: null };
    expect(await measureMetric(db, { ...base, metric: "view_rate", zoneId: net.zone.id }, "2026-09-20", "2026-09-21")).toEqual({ value: 0.1, days: 1 });
    expect((await measureMetric(db, { ...base, metric: "rev_per_1k", siteId: "s1", networkId: net.net.id }, "2026-09-20", "2026-09-21")).value).toBeCloseTo(1, 3);
    expect(await measureMetric(db, { ...base, metric: "revenue", siteId: "s1", format: "BANNER" }, "2026-09-20", "2026-09-21")).toEqual({ value: 1.2, days: 1 });
    // The factory already bills tubecrown $34 on s1 over the two days (JP $12 + US $5, twice); one more cell makes $40 over 10 000 loads.
    await db.factCost.create({ data: { date: D1, siteId: "s1", countryCode: "DE", sourceSlug: "tubecrown", rateModel: "CPM", rate: "1", cost: "6" } });
    await db.factTrafficSource.create({ data: { date: D1, siteId: "s1", sourceSlug: "tubecrown", pageLoads: 10_000, revenueReported: "6" } });
    expect((await measureMetric(db, { ...base, metric: "cost_per_1k", siteId: "s1", sourceSlug: "tubecrown" }, "2026-09-20", "2026-09-21")).value).toBeCloseTo(4, 3);
    const share = await measureMetric(db, { ...base, metric: "cost_share", bundleId: net.jav.id }, "2026-09-20", "2026-09-21");
    expect(share.days).toBe(2); expect(share.value).toBeGreaterThan(0);
    expect(await measureMetric(db, { ...base, metric: "margin", countryCode: "JP" }, "2026-09-20", "2026-09-21")).toEqual({ value: null, days: 0 }); // no object
  });

  it("the page list filters by tab, scope and bundle; counts and the overview top follow", async () => {
    await generateHypotheses(db, TODAY);
    const own = await createHypothesis(db, { title: "Своя", hypothesis: "Если сделать X, то будет Y", bundleId: net.hentai.id, impactMonth: "9999" });
    const proposed = await hypothesesList({ tab: "proposed" });
    expect(proposed.some((h) => h.id === own)).toBe(true);
    expect(proposed.every((h) => h.status === "PROPOSED")).toBe(true);
    const zones = await hypothesesList({ tab: "proposed", scope: "zone" });
    expect(zones.length).toBeGreaterThan(0); expect(zones.every((h) => h.scope === "zone")).toBe(true);
    const hentai = await hypothesesList({ tab: "proposed", bundleSiteIds: ["s2", "s3"], bundleId: net.hentai.id });
    expect(hentai.some((h) => h.id === own)).toBe(true);
    expect(hentai.every((h) => h.bundleId === net.hentai.id || ["s2", "s3"].includes(h.siteId ?? ""))).toBe(true);
    const counts = await hypothesisCounts({});
    expect(counts.tabs.proposed).toBe(proposed.length); expect(counts.tabs.accepted).toBe(0);
    expect((await topHypotheses(1))[0].id).toBe(own); // the biggest expected effect leads
  });
});
