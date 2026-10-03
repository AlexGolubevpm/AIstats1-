import { describe, expect, it } from "vitest";
import { floorRecs, freePlaceRecs, fromAlert, lossSites, mergeRecs, sourceRecs, zoneRecs } from "@/server/domain/recommendations";

describe("recommendations", () => {
  it("an alert becomes a recommendation: the last sentence is the action, money at risk is the impact", () => {
    const r = fromAlert({ id: "a1", rule: "loss_geo", entityKey: "site:s1|country:JP", level: "CRITICAL", title: "Убыточное гео JP на one.test", siteId: "s1", domain: "one.test", moneyAtRisk: 4,
      message: "За 7 дней выручка $20.00 при расходе $24.00 (ROMI -16.7%). Снизить закупку гео или поднять флор.", link: "/sites/one.test?by=geo" });
    expect(r).toMatchObject({ id: "alert:a1", scope: "geo", site: { id: "s1", domain: "one.test" }, objectKey: "loss_geo|site:s1|country:JP", action: "Снизить закупку гео или поднять флор.", impact: 4, source: "alert", level: "CRITICAL" });
    expect(r.why).toBe("За 7 дней выручка $20.00 при расходе $24.00 (ROMI -16.7%).");
  });

  it("rules: loss site, dead and invisible zones, network below the floor, a source eating revenue, free places on top sites", () => {
    expect(lossSites([{ id: "s1", domain: "a.test", revenue: 10, cost: 15, margin: -5, romi: -33.3 }, { id: "s2", domain: "b.test", revenue: 10, cost: 5, margin: 5, romi: 100 }], 7))
      .toMatchObject([{ id: "site-loss:s1", scope: "site", impact: 5, level: "CRITICAL" }]);
    const zones = zoneRecs([
      { zoneId: "z1", siteId: "s1", domain: "a.test", zone: "Footer", format: "BANNER", revenue: 0.5, share: 0.005, impShare: 0.2, imps: 500_000, imps7: 60_000, viewRate7: 0.1 },
      { zoneId: "z2", siteId: "s1", domain: "a.test", zone: "Tiny", format: "BANNER", revenue: 0, share: 0, impShare: 0.01, imps: 10, imps7: 10, viewRate7: 0 }, // under the alert thresholds
    ]);
    expect(zones.map((z) => z.id)).toEqual(["zone-dead:z1", "zone-invisible:z1"]);
    expect(floorRecs([{ siteId: "s1", domain: "a.test", network: "Net", revPer1k: 1, floor: 2, volShare: 0.4, pageLoads: 100_000, belowFloor: true },
      { siteId: "s1", domain: "a.test", network: "Small", revPer1k: 1, floor: 2, volShare: 0.05, pageLoads: 1000, belowFloor: true }], 7))
      .toMatchObject([{ id: "floor:s1:Net", impact: 100, action: "Поднять флор Net до $2.00 за 1000 загрузок или опустить в waterfall." }]);
    expect(sourceRecs([{ siteId: "s1", domain: "a.test", source: "TubeCrown", cost: 80, siteRevenue: 100, loadsShare: 0.7 }, { siteId: "s1", domain: "a.test", source: "Direct", cost: 0, siteRevenue: 100, loadsShare: 0.3 }], 7))
      .toMatchObject([{ id: "source:s1:TubeCrown", impact: 30, scope: "source" }]);
    expect(freePlaceRecs([{ siteId: "s1", domain: "a.test", free: 3, places: 10, revenue: 500, rank: 1 }, { siteId: "s2", domain: "b.test", free: 10, places: 10, revenue: 1, rank: 20 }]))
      .toMatchObject([{ id: "free:s1", title: "3 свободных места на a.test", level: "INFO" }]);
  });

  it("merge: an alert about the same object wins over the rule; critical first, then by impact", () => {
    const alert = fromAlert({ id: "a", rule: "dead_zone", entityKey: "zone:z1", level: "WARNING", title: "Мёртвая зона: Footer на a.test", siteId: "s1", domain: "a.test", moneyAtRisk: 0, message: "x. Снести.", link: "/" });
    const rule = zoneRecs([{ zoneId: "z1", siteId: "s1", domain: "a.test", zone: "Footer", format: "BANNER", revenue: 0.5, share: 0.005, impShare: 0.2, imps: 5000, imps7: 1000, viewRate7: null }])[0];
    const loss = lossSites([{ id: "s1", domain: "a.test", revenue: 10, cost: 15, margin: -5, romi: -33.3 }], 7)[0];
    const merged = mergeRecs([[alert], [rule, loss]]);
    expect(merged.map((r) => r.id)).toEqual(["site-loss:s1", "alert:a"]);
  });
});
