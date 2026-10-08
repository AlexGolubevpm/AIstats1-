import { describe, expect, it } from "vitest";
import {
  bundleCostShare, dealBelowRotation, floorRecs, formatMissingVsPeers, freePlaceRecs, fromAlert, geoBelowNetwork, levelOf, lossSites, marginDrop, median,
  mergeCandidates, networkUnderused, parseEntityKey, siteBelowBundle, sourceAboveRevenue, sourceRecs, zoneRecs,
} from "@/server/domain/hypotheses";

const bundle = (siteId: string, domain: string, revenue: number, pageLoads: number, cost = 0, bundleId = "b1") =>
  ({ bundleId, bundleTitle: "JAV", bundleSlug: "jav", siteId, domain, revenue, pageLoads, cost });

describe("hypotheses from alerts", () => {
  it("an alert becomes a hypothesis: same rule and object key as the rule about it; payload.action leads the sentence; money at risk is the effect", () => {
    const h = fromAlert({ id: "a1", rule: "invisible_zone", entityKey: "zone:z1", level: "WARNING", title: "Зона не видна: Footer на one.test", siteId: "s1", domain: "one.test", moneyAtRisk: 12,
      message: "View rate 9.0%, viewable CPM $1.2000. При view rate 35% зона дала бы ≈$42.00 за 7 дней вместо $10.80.", link: "/sites/one.test?by=zones",
      action: "Поднять зону выше фолда или перенести на другое место." });
    expect(h).toMatchObject({ ruleKey: "invisible_zone", objectKey: "zone:z1", scope: "zone", source: "ALERT", alertId: "a1", zoneId: "z1", siteId: "s1", impactMonth: 12, metric: "view_rate" });
    expect(h.hypothesis.startsWith("Поднять зону выше фолда")).toBe(true);
    // An alert stored before actions existed: the last sentence still serves.
    const old = fromAlert({ id: "a2", rule: "loss_geo", entityKey: "site:s1|country:JP", level: "CRITICAL", title: "Убыточное гео JP на one.test", siteId: "s1", domain: "one.test", moneyAtRisk: 4,
      message: "За 7 дней выручка $20.00 при расходе $24.00 (ROMI -16.7%). Снизить закупку гео или поднять флор.", link: "/sites/one.test?by=geo" });
    expect(old.hypothesis).toBe("Снизить закупку гео или поднять флор. — За 7 дней выручка $20.00 при расходе $24.00 (ROMI -16.7%).");
    expect(old).toMatchObject({ countryCode: "JP", siteId: "s1", scope: "geo", metric: "margin" });
    expect(parseEntityKey("deal:d1|from:2026-09-01")).toEqual({ dealId: "d1" });
  });
});

describe("rules carried over", () => {
  it("loss site, dead and invisible zones, network below the floor, a source eating revenue, free places on top sites", () => {
    expect(lossSites([{ id: "s1", domain: "a.test", revenue: 10, cost: 15, margin: -5, romi: -33.3 }, { id: "s2", domain: "b.test", revenue: 10, cost: 5, margin: 5, romi: 100 }], 7))
      .toMatchObject([{ ruleKey: "site_loss", objectKey: "site:s1", scope: "site", impactMonth: 21.43, level: "CRITICAL", metric: "margin" }]); // $5 a week → $21.43 a month
    const zones = zoneRecs([
      { zoneId: "z1", siteId: "s1", domain: "a.test", zone: "Footer", format: "BANNER", revenue: 0.5, share: 0.005, impShare: 0.2, imps: 500_000, imps7: 60_000, revenue7: 0.3, viewRate7: 0.1 },
      { zoneId: "z2", siteId: "s1", domain: "a.test", zone: "Tiny", format: "BANNER", revenue: 0, share: 0, impShare: 0.01, imps: 10, imps7: 10, revenue7: 0, viewRate7: 0 },
      { zoneId: "z3", siteId: "s1", domain: "a.test", zone: "NoRate", format: "BANNER", revenue: 20, share: 0.3, impShare: 0.3, imps: 900_000, imps7: 200_000, revenue7: 5, viewRate7: 0 },
      { zoneId: "z4", siteId: "s1", domain: "a.test", zone: "Empty", format: "BANNER", revenue: 0, share: 0, impShare: 0.01, imps: 300_000, imps7: 80_000, revenue7: 0, viewRate7: 0.05 },
      { zoneId: "z5", siteId: "s1", domain: "a.test", zone: "Small dead", format: "BANNER", revenue: 0.1, share: 0.001, impShare: 0.06, imps: 20_000, imps7: 5_000, revenue7: 0, viewRate7: null },
    ]);
    expect(zones.map((z) => `${z.ruleKey}|${z.objectKey}`)).toEqual(["dead_zone|zone:z1", "invisible_zone|zone:z1"]);
    expect(zones[1].impactMonth).toBeCloseTo(((0.3 * 0.35) / 0.1 - 0.3) * (30 / 7), 2); // at 35% view rate instead of 10%
    expect(floorRecs([{ siteId: "s1", domain: "a.test", network: "Net", revPer1k: 1, floor: 2, volShare: 0.4, pageLoads: 100_000, belowFloor: true },
      { siteId: "s1", domain: "a.test", network: "Small", revPer1k: 1, floor: 2, volShare: 0.05, pageLoads: 1000, belowFloor: true }], 7))
      .toMatchObject([{ ruleKey: "network_below_floor", objectKey: "site:s1|net:Net", impactMonth: 428.57, level: "CRITICAL" }]); // $100 a week
    expect(sourceRecs([{ siteId: "s1", domain: "a.test", source: "TubeCrown", sourceSlug: "tubecrown", cost: 70, siteRevenue: 100, loadsShare: 0.5 },
      { siteId: "s1", domain: "a.test", source: "Direct", sourceSlug: "direct", cost: 1, siteRevenue: 100, loadsShare: 0.5 }], 7))
      .toMatchObject([{ ruleKey: "source_eats_revenue", objectKey: "site:s1|source:tubecrown", impactMonth: 85.71, metric: "cost_share" }]);
    expect(freePlaceRecs([{ siteId: "s1", domain: "a.test", free: 3, places: 21, revenue: 50, rank: 1 }, { siteId: "s2", domain: "b.test", free: 3, places: 21, revenue: 1, rank: 11 }]))
      .toMatchObject([{ ruleKey: "free_places", objectKey: "site:s1", level: "INFO" }]);
  });
});

describe("rules over the daily analytics", () => {
  it("median and level", () => {
    expect(median([3, 1, 2])).toBe(2); expect(median([1, 2, 3, 4])).toBe(2.5); expect(median([])).toBeNull();
    expect([levelOf(500), levelOf(50), levelOf(5), levelOf(5, "CRITICAL"), levelOf(50, "CRITICAL")]).toEqual(["CRITICAL", "WARNING", "INFO", "CRITICAL", "CRITICAL"]);
  });

  it("a site under 75% of its bundle's median rev/1k; bundles with fewer than three sites with traffic say nothing", () => {
    const rows = [bundle("s1", "a.test", 100, 100_000), bundle("s2", "b.test", 200, 100_000), bundle("s3", "c.test", 300, 100_000), bundle("s4", "tiny.test", 0, 1000)];
    const out = siteBelowBundle(rows, 7);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ ruleKey: "site_below_bundle", objectKey: "site:s1|bundle:b1", siteId: "s1", bundleId: "b1", metric: "rev_per_1k", scope: "site" });
    expect(out[0].evidence).toMatchObject({ revPer1k: 1, bundleMedian: 2, leader: "c.test", sites: 3 });
    expect(out[0].impactMonth).toBeCloseTo(((2 - 1) * 100_000) / 1000 * (30 / 7), 2); // $100 a week at the median
    expect(siteBelowBundle(rows.slice(0, 2), 7)).toEqual([]);
  });

  it("a country paying under 70% of its network median on one site; ZZ/XX and thin traffic are skipped", () => {
    const geo = (siteId: string, cc: string, revenue: number, pageLoads = 20_000) => ({ siteId, domain: `${siteId}.test`, countryCode: cc, revenue, pageLoads });
    const out = geoBelowNetwork([geo("s1", "JP", 10), geo("s2", "JP", 40), geo("s3", "JP", 50), geo("s4", "JP", 1, 500), geo("s1", "ZZ", 0), geo("s2", "ZZ", 0), geo("s3", "ZZ", 0)], 7);
    expect(out.map((h) => h.objectKey)).toEqual(["site:s1|country:JP"]);
    expect(out[0]).toMatchObject({ scope: "geo", countryCode: "JP", siteId: "s1", metric: "rev_per_1k" });
    expect(out[0].evidence).toMatchObject({ revPer1k: 0.5, networkMedian: 2, sites: 3 });
  });

  it("a format earning on at least half of the bundle's peers and absent on a site", () => {
    const sites = [bundle("s1", "a.test", 100, 100_000), bundle("s2", "b.test", 100, 100_000), bundle("s3", "c.test", 100, 100_000), bundle("s4", "d.test", 100, 100_000)];
    const formats = [
      { siteId: "s1", format: "POPUNDER", revenue: 50, pageLoads: 100_000 }, { siteId: "s2", format: "POPUNDER", revenue: 70, pageLoads: 100_000 }, { siteId: "s3", format: "POPUNDER", revenue: 60, pageLoads: 100_000 },
      { siteId: "s1", format: "SLIDER", revenue: 5, pageLoads: 100_000 }, // only one peer earns on sliders: not a pattern
      { siteId: "s4", format: "BANNER", revenue: 5, pageLoads: 100_000 },
    ];
    const out = formatMissingVsPeers(sites, formats, 7);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ ruleKey: "format_missing", objectKey: "site:s4|format:POPUNDER", siteId: "s4", format: "POPUNDER", scope: "format", metric: "revenue" });
    expect(out[0].evidence).toMatchObject({ peersEarning: 3, peers: 4, peerMedianPer1k: 0.6 });
    expect(out[0].impactMonth).toBeCloseTo((0.6 * 100_000) / 1000 * (30 / 7), 2);
  });

  it("a top-2 network of the bundle's peers that carries under 10% of a site's volume", () => {
    const row = (siteId: string, networkId: string, network: string, revenue: number, pageLoads: number, siteRevenue = 100, siteLoads = 100_000) =>
      ({ bundleId: "b1", bundleTitle: "JAV", bundleSlug: "jav", siteId, domain: `${siteId}.test`, networkId, network, revenue, pageLoads, siteLoads, siteRevenue });
    const out = networkUnderused([
      row("s1", "n1", "Gold", 60, 20_000), row("s2", "n1", "Gold", 50, 20_000), row("s3", "n1", "Gold", 1, 2_000), // Gold: $3/1k on peers, 2% of s3's volume
      row("s1", "n2", "Bulk", 40, 80_000), row("s2", "n2", "Bulk", 50, 80_000), row("s3", "n2", "Bulk", 99, 98_000),
    ], 7);
    expect(out.map((h) => h.objectKey)).toEqual(["site:s3|net:n1"]);
    expect(out[0]).toMatchObject({ networkId: "n1", siteId: "s3", scope: "network", metric: "rev_per_1k" });
    expect(out[0].evidence).toMatchObject({ network: "Gold", peerMedianPer1k: 2.5, siteRevPer1k: 1, volShare: 0.02 }); // median of $3, $2.5 and $0.5
  });

  it("traffic bought above the site's revenue per 1000 loads; cheap or thin sources pass", () => {
    const out = sourceAboveRevenue([
      { siteId: "s1", domain: "a.test", sourceSlug: "tc", source: "TubeCrown", cost: 30, loads: 10_000, siteRevenue: 100, siteLoads: 100_000 }, // $3 vs $1
      { siteId: "s1", domain: "a.test", sourceSlug: "ok", source: "Cheap", cost: 5, loads: 10_000, siteRevenue: 100, siteLoads: 100_000 },
      { siteId: "s1", domain: "a.test", sourceSlug: "thin", source: "Thin", cost: 30, loads: 100, siteRevenue: 100, siteLoads: 100_000 },
    ], 7);
    expect(out.map((h) => h.objectKey)).toEqual(["site:s1|source:tc"]);
    expect(out[0]).toMatchObject({ metric: "cost_per_1k", level: "CRITICAL", scope: "source" });
    expect(out[0].impactMonth).toBeCloseTo(((3 - 1) * 10_000) / 1000 * (30 / 7), 2);
  });

  it("a margin down a fifth week over week names the cut that fell the most", () => {
    const out = marginDrop([
      { siteId: "s1", domain: "a.test", revenue: 80, prevRevenue: 120, margin: 60, prevMargin: 100, drops: [{ kind: "гео", name: "JP", delta: -30 }, { kind: "сетка", name: "Gold", delta: -5 }] },
      { siteId: "s2", domain: "b.test", revenue: 100, prevRevenue: 100, margin: 90, prevMargin: 100, drops: [] }, // -10%: not a drop
      { siteId: "s3", domain: "c.test", revenue: 10, prevRevenue: 10, margin: 1, prevMargin: 8, drops: [] }, // too small to matter
    ], 7);
    expect(out.map((h) => h.objectKey)).toEqual(["site:s1"]);
    expect(out[0].hypothesis).toContain("гео JP ($-30.00)");
    expect(out[0]).toMatchObject({ metric: "margin", impactMonth: 171.43 }); // $40 a week
  });

  it("a bundle spending 10 pp more of its revenue on traffic than the network; a deal paying under 70% of the rotation", () => {
    const b = bundleCostShare([{ bundleId: "b1", title: "JAV", slug: "jav", revenue: 1000, cost: 600 }, { bundleId: "b2", title: "Gay", slug: "gay", revenue: 1000, cost: 350 }], { revenue: 2000, cost: 950 }, 7);
    expect(b.map((h) => h.objectKey)).toEqual(["bundle:b1"]);
    expect(b[0]).toMatchObject({ scope: "bundle", bundleId: "b1", metric: "cost_share" });
    expect(b[0].evidence).toMatchObject({ costShare: 0.6, networkShare: 0.475 });
    const d = dealBelowRotation([
      { dealId: "d1", title: "Banner", advertiser: "Acme", siteId: "s1", domain: "a.test", format: "BANNER", dealRevenue: 10, dealLoads: 20_000, rotationPer1k: 1 }, // $0.5 vs $1
      { dealId: "d2", title: "Good", advertiser: "Acme", siteId: "s1", domain: "a.test", format: "BANNER", dealRevenue: 30, dealLoads: 20_000, rotationPer1k: 1 },
      { dealId: "d3", title: "NoRot", advertiser: "Acme", siteId: "s1", domain: "a.test", format: "BANNER", dealRevenue: 1, dealLoads: 20_000, rotationPer1k: null },
    ], 7);
    expect(d.map((h) => h.objectKey)).toEqual(["deal:d1|site:s1"]);
    expect(d[0]).toMatchObject({ dealId: "d1", scope: "deal", link: "/deals/d1" });
    expect(d[0].impactMonth).toBeCloseTo(((1 - 0.5) * 20_000) / 1000 * (30 / 7), 2);
  });

  it("merge: an alert about the same object wins over the rule; critical first, then by effect", () => {
    const alert = fromAlert({ id: "a", rule: "dead_zone", entityKey: "zone:z1", level: "WARNING", title: "Мёртвая зона: Footer на a.test", siteId: "s1", domain: "a.test", moneyAtRisk: 0, message: "x. Снести.", link: "/" });
    const rule = zoneRecs([{ zoneId: "z1", siteId: "s1", domain: "a.test", zone: "Footer", format: "BANNER", revenue: 0.5, share: 0.005, impShare: 0.2, imps: 500_000, imps7: 1000, revenue7: 0, viewRate7: null }])[0];
    const loss = lossSites([{ id: "s1", domain: "a.test", revenue: 10, cost: 15, margin: -5, romi: -33.3 }], 7)[0];
    const merged = mergeCandidates([[alert], [rule, loss]]);
    expect(merged.map((r) => `${r.ruleKey}|${r.objectKey}|${r.source}`)).toEqual(["site_loss|site:s1|AUTO", "dead_zone|zone:z1|ALERT"]);
  });
});
