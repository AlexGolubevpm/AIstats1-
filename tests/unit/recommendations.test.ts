import { describe, expect, it } from "vitest";
import { floorRecs, freePlaceRecs, fromAlert, lossSites, mergeRecs, sourceRecs, zoneRecs } from "@/server/domain/recommendations";

describe("recommendations", () => {
  it("an alert becomes a recommendation: payload.action is the action and the message the why; money at risk is the impact", () => {
    const r = fromAlert({ id: "a1", rule: "invisible_zone", entityKey: "zone:z1", level: "WARNING", title: "Зона не видна: Footer на one.test", siteId: "s1", domain: "one.test", moneyAtRisk: 12,
      message: "View rate 9.0%, viewable CPM $1.2000. При view rate 35% зона дала бы ≈$42.00 за 7 дней вместо $10.80.", link: "/sites/one.test?by=zones",
      action: "Поднять зону выше фолда или перенести на другое место." });
    expect(r).toMatchObject({ id: "alert:a1", scope: "zone", objectKey: "invisible_zone|zone:z1", action: "Поднять зону выше фолда или перенести на другое место.", impact: 12, source: "alert" });
    expect(r.why).toBe("View rate 9.0%, viewable CPM $1.2000. При view rate 35% зона дала бы ≈$42.00 за 7 дней вместо $10.80."); // the estimate is never the action
    // An alert stored before actions existed: the last sentence still serves.
    const old = fromAlert({ id: "a2", rule: "loss_geo", entityKey: "site:s1|country:JP", level: "CRITICAL", title: "Убыточное гео JP на one.test", siteId: "s1", domain: "one.test", moneyAtRisk: 4,
      message: "За 7 дней выручка $20.00 при расходе $24.00 (ROMI -16.7%). Снизить закупку гео или поднять флор.", link: "/sites/one.test?by=geo" });
    expect([old.action, old.why]).toEqual(["Снизить закупку гео или поднять флор.", "За 7 дней выручка $20.00 при расходе $24.00 (ROMI -16.7%)."]);
  });

  it("rules: loss site, dead and invisible zones, network below the floor, a source eating revenue, free places on top sites", () => {
    expect(lossSites([{ id: "s1", domain: "a.test", revenue: 10, cost: 15, margin: -5, romi: -33.3 }, { id: "s2", domain: "b.test", revenue: 10, cost: 5, margin: 5, romi: 100 }], 7))
      .toMatchObject([{ id: "site-loss:s1", scope: "site", impact: 5, level: "CRITICAL" }]);
    const zones = zoneRecs([
      { zoneId: "z1", siteId: "s1", domain: "a.test", zone: "Footer", format: "BANNER", revenue: 0.5, share: 0.005, impShare: 0.2, imps: 500_000, imps7: 60_000, revenue7: 0.3, viewRate7: 0.1 },
      { zoneId: "z2", siteId: "s1", domain: "a.test", zone: "Tiny", format: "BANNER", revenue: 0, share: 0, impShare: 0.01, imps: 10, imps7: 10, revenue7: 0, viewRate7: 0 }, // under the alert thresholds
      { zoneId: "z3", siteId: "s1", domain: "a.test", zone: "NoRate", format: "BANNER", revenue: 20, share: 0.3, impShare: 0.3, imps: 900_000, imps7: 200_000, revenue7: 5, viewRate7: 0 }, // ADOK sent no view rate: nothing to say
      { zoneId: "z4", siteId: "s1", domain: "a.test", zone: "Empty", format: "BANNER", revenue: 0, share: 0, impShare: 0.01, imps: 300_000, imps7: 80_000, revenue7: 0, viewRate7: 0.05 }, // no revenue: "$0 instead of $0" is noise
      { zoneId: "z5", siteId: "s1", domain: "a.test", zone: "Small dead", format: "BANNER", revenue: 0.1, share: 0.001, impShare: 0.06, imps: 20_000, imps7: 5_000, revenue7: 0, viewRate7: null }, // under 50 000 imps
    ]);
    expect(zones.map((z) => z.id)).toEqual(["zone-dead:z1", "zone-invisible:z1"]);
    expect(floorRecs([{ siteId: "s1", domain: "a.test", network: "Net", revPer1k: 1, floor: 2, volShare: 0.4, pageLoads: 100_000, belowFloor: true },
      { siteId: "s1", domain: "a.test", network: "Small", revPer1k: 1, floor: 2, volShare: 0.05, pageLoads: 1000, belowFloor: true }], 7))
      .toMatchObject([{ id: "floor:s1:Net", impact: 100, action: "Поднять флор Net до $2.0000 за 1000 загрузок или опустить в waterfall." }]);
    expect(floorRecs([{ siteId: "s1", domain: "a.test", network: "Net", revPer1k: 0.001, floor: 0, volShare: 0.4, pageLoads: 100_000, belowFloor: true }], 7)).toEqual([]); // no floor, no advice
    expect(sourceRecs([{ siteId: "s1", domain: "a.test", source: "TubeCrown", cost: 80, siteRevenue: 100, loadsShare: 0.7 }, { siteId: "s1", domain: "a.test", source: "Direct", cost: 0, siteRevenue: 100, loadsShare: 0.3 }], 7))
      .toMatchObject([{ id: "source:s1:TubeCrown", impact: 30, scope: "source" }]);
    expect(freePlaceRecs([{ siteId: "s1", domain: "a.test", free: 3, places: 10, revenue: 500, rank: 1 }, { siteId: "s2", domain: "b.test", free: 10, places: 10, revenue: 1, rank: 20 },
      { siteId: "s3", domain: "c.test", free: 10, places: 10, revenue: 0, rank: 2 }])) // "site №2 by revenue ($0.00)" is not a recommendation
      .toMatchObject([{ id: "free:s1", title: "3 свободных места на a.test", level: "INFO" }]);
  });

  it("merge: an alert about the same object wins over the rule; critical first, then by impact", () => {
    const alert = fromAlert({ id: "a", rule: "dead_zone", entityKey: "zone:z1", level: "WARNING", title: "Мёртвая зона: Footer на a.test", siteId: "s1", domain: "a.test", moneyAtRisk: 0, message: "x. Снести.", link: "/" });
    const rule = zoneRecs([{ zoneId: "z1", siteId: "s1", domain: "a.test", zone: "Footer", format: "BANNER", revenue: 0.5, share: 0.005, impShare: 0.2, imps: 500_000, imps7: 1000, revenue7: 0, viewRate7: null }])[0];
    const loss = lossSites([{ id: "s1", domain: "a.test", revenue: 10, cost: 15, margin: -5, romi: -33.3 }], 7)[0];
    const merged = mergeRecs([[alert], [rule, loss]]);
    expect(merged.map((r) => r.id)).toEqual(["site-loss:s1", "alert:a"]);
  });
});
