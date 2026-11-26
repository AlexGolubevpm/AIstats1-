import { describe, expect, it } from "vitest";
import { bidCostPer1kLoads, cpm } from "@/lib/metrics";
import { countryValues, formatScoped, popunderScoped, spotValues, t12Revenue, t12Scoped } from "@/server/ingest/adspyglass/filters";

const M = (o: Partial<{ pageLoads: number; impsOwn: number; revenue: number; predicted: number }>) => ({ pageLoads: 0, impsOwn: 0, impsNetwork: 0, clicks: 0, revenue: 0, predicted: 0, ...o });

describe("the price of 1000 loads from a CPM bid", () => {
  it("bid per 1000 visits / loads per visit", () => {
    expect(bidCostPer1kLoads(2, 2)).toBe(1);
    expect(bidCostPer1kLoads(1.2, 1)).toBe(1.2);
    expect(bidCostPer1kLoads(1, 0)).toBeNull();
  });
  it("the CPM of a row is its revenue over its impressions — a ratio of sums, never a mean of the formats' CPMs", () => {
    // popunder $10 on 5 500 impressions ($1.82), banner $14 on 16 500 ($0.85): the tier is $24 / 22 000 = $1.09, not their mean $1.33
    expect(cpm(10 + 14, 5_500 + 16_500)).toBeCloseTo(1.0909, 4);
    expect(cpm(1, 0)).toBeNull();
  });
});

describe("ADOK filters of «Закупка T1/T2»", () => {
  it("filter values: zone ids or the format name; T1/T2 countries as ISO or ADOK ids", () => {
    expect(spotValues({ param: "spots_ids[]", kind: "zone_ids" }, [5, 6])).toEqual(["5", "6"]);
    expect(spotValues({ param: "ad_types[]", kind: "ad_type", value: "popunder" }, [])).toEqual(["popunder"]);
    const rows = [{ name: "United States", iso: "US", id: 840 }, { name: "Germany", iso: "de", id: 276 }, { name: "India", iso: "IN", id: 356 }];
    const t12 = new Set(["US", "DE", "GB"]);
    expect(countryValues({ param: "countries[]", kind: "iso" }, rows, t12)).toEqual(["US", "DE"]);
    expect(countryValues({ param: "countries_ids[]", kind: "id" }, rows, t12)).toEqual(["840", "276"]);
    expect(countryValues({ param: "countries_ids[]", kind: "id" }, [{ name: "United States", iso: "US" }], t12)).toEqual([]);
  });
  it("a zone-filtered answer counts as popunder only by impressions: not above the format, not the whole site", () => {
    const rows = [{ name: "US", impressions: 900 }, { name: "DE", impressions: 100 }];
    expect(popunderScoped(rows, { impsOwn: 1000 }, { impsOwn: 5000 }).ok).toBe(true);
    expect(popunderScoped(rows, { impsOwn: 500 }, { impsOwn: 5000 }).ok).toBe(false); // more than popunder has
    expect(popunderScoped([{ name: "US", impressions: 5000 }], null, { impsOwn: 5000 }).ok).toBe(false); // the whole site: ignored
    expect(popunderScoped([], { impsOwn: 1 }, null).why).toBe("пустой ответ");
  });
  it("a country-filtered source answer must match the T1/T2 loads (±10%)", () => {
    expect(t12Scoped([{ name: "TubeCrown", hits: 600 }, { name: "Direct", hits: 380 }], 1000, 4000).ok).toBe(true);
    expect(t12Scoped([{ name: "TubeCrown", hits: 4000 }], 1000, 4000).ok).toBe(false);
    expect(t12Scoped([{ name: "TubeCrown", hits: 700 }], 1000, 4000).ok).toBe(false);
  });
  it("an unfiltered broker_income is replaced by the source's revenue × its T1/T2 share of predicted income", () => {
    const all = M({ pageLoads: 1000, revenue: 10, predicted: 8 });
    expect(t12Revenue(M({ pageLoads: 400, revenue: 4, predicted: 3 }), all)).toBe(4); // filtered: kept
    expect(t12Revenue(M({ pageLoads: 400, revenue: 10, predicted: 4 }), all)).toBeCloseTo(5); // unfiltered: 10 × 4 / 8
    expect(t12Revenue(M({ pageLoads: 400, revenue: 10, predicted: 0 }), M({ pageLoads: 1000, revenue: 10 }))).toBeCloseTo(4); // no estimate: by loads
    expect(t12Revenue(M({ revenue: 3 }), undefined)).toBe(3);
  });
  it("any formats: zone ids as they are, or ADOK's type names for a type filter", () => {
    expect(spotValues({ param: "spots_ids[]", kind: "zone_ids" }, [7], ["BANNER"])).toEqual(["7"]);
    expect(spotValues({ param: "ad_types[]", kind: "ad_type" }, [], ["POPUNDER", "BANNER", "OTHER"])).toEqual(["popunder", "banner"]);
  });
  it("both filters together: a narrower answer by impressions", () => {
    expect(formatScoped(5500, 21000, 0.27).ok).toBe(true);
    expect(formatScoped(21000, 21000, 0.27).ok).toBe(false); // the zone filter was ignored
    expect(formatScoped(21000, 21000, 1).ok).toBe(true); // the formats are the whole site
    expect(formatScoped(0, 100, null).ok).toBe(false);
  });
});
