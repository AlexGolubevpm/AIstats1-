import { describe, expect, it } from "vitest";
import { bidAdvice, bidElasticity } from "@/lib/metrics";
import { countryValues, popunderScoped, spotValues, t12Revenue, t12Scoped } from "@/server/ingest/adspyglass/filters";

const M = (o: Partial<{ pageLoads: number; impsOwn: number; revenue: number; predicted: number }>) => ({ pageLoads: 0, impsOwn: 0, impsNetwork: 0, clicks: 0, revenue: 0, predicted: 0, ...o });

describe("bidAdvice — may the T1/T2 bid go up", () => {
  it("compares the price of 1000 bought loads with popunder revenue per 1000 loads (ratios of sums)", () => {
    // 200 000 T1/T2 loads, $300 popunder → $1.50 / 1000; 100 000 paid loads cost $100 → $1.00 / 1000
    const a = bidAdvice({ popRevenue: 300, allRevenue: 500, loads: 200_000, cost: 100, paidLoads: 100_000 }, 0.2);
    expect(a.popPer1k).toBeCloseTo(1.5);
    expect(a.allPer1k).toBeCloseTo(2.5);
    expect(a.costPer1k).toBeCloseTo(1);
    expect(a.popMarginPer1k).toBeCloseTo(0.5);
    expect(a.maxBid).toBeCloseTo(1.2); // 1.5 × (1 − 20%)
    expect(a.headroom).toBeCloseTo(0.2);
    expect(a.verdict).toBe("raise");
  });
  it("edge within ±5% of the limit, hold above it, no_data without a price", () => {
    expect(bidAdvice({ popRevenue: 125, allRevenue: 125, loads: 100_000, cost: 100, paidLoads: 100_000 }, 0.2).verdict).toBe("edge"); // limit $1.00 = price
    expect(bidAdvice({ popRevenue: 80, allRevenue: 200, loads: 100_000, cost: 100, paidLoads: 100_000 }, 0.2).verdict).toBe("hold");
    expect(bidAdvice({ popRevenue: 80, allRevenue: 200, loads: 100_000, cost: 0, paidLoads: 0 }).verdict).toBe("no_data");
    expect(bidAdvice({ popRevenue: 0, allRevenue: 0, loads: 0, cost: 10, paidLoads: 1000 }).verdict).toBe("no_data");
  });
});

describe("bidElasticity — what dearer days did", () => {
  it("splits priced days at the median price: dearer half against the cheaper one", () => {
    const day = (price: number, loads: number, pop: number) => ({ loads, popRevenue: pop, cost: (price * loads) / 1000, paidLoads: loads });
    const e = bidElasticity([day(1, 100_000, 150), day(1, 100_000, 150), day(1.2, 130_000, 182), day(1.2, 130_000, 182), day(0, 50, 0)])!;
    expect(e.days).toBe(4); // the day without a price is left out
    expect(e.priceChange).toBeCloseTo(0.2);
    expect(e.loadsChange).toBeCloseTo(0.3);
    expect(e.popPer1kChange).toBeCloseTo(1.4 / 1.5 - 1);
    expect(bidElasticity([day(1, 1, 1), day(2, 1, 1), day(3, 1, 1)])).toBeNull();
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
});
