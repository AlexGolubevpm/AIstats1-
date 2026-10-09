import { describe, expect, it } from "vitest";
import { allocateBroker, apportion, mapCountryRows, measures, type Measures } from "@/server/ingest/adspyglass/map";
import { CountryResolver } from "@/server/ingest/normalize";

const resolver = () => new CountryResolver([{ code: "JP", nameEn: "Japan" }, { code: "US", nameEn: "United States" }, { code: "XK", nameEn: "Kosovo" }], []);

describe("mapCountryRows", () => {
  it("prefers the iso field, falls back to the name, sums duplicates", () => {
    const r = resolver();
    const cells = mapCountryRows([
      { name: "Nippon (whatever)", iso: "jp", hits: 10, broker_income: 1 },
      { name: "Japan", hits: 5, broker_income: 2 },
      { name: "United States", iso: "", hits: 3, broker_income: 0.5 },
      { name: "Atlantis", iso: "ZZZ", hits: 1, broker_income: 0 },
    ], r);
    const by = Object.fromEntries(cells.map((c) => [c.countryCode, c.m]));
    expect(by.JP).toMatchObject({ pageLoads: 15, revenue: 3 });
    expect(by.US).toMatchObject({ pageLoads: 3 });
    expect(by.XX).toMatchObject({ pageLoads: 1 });
    expect([...r.unresolved.values()].map((u) => u.raw)).toEqual(["Atlantis"]); // name-resolved rows only miss when name is unknown
  });

  it("an unknown iso code is not trusted", () => {
    const r = resolver();
    expect(mapCountryRows([{ name: "Kosovo", iso: "QQ", hits: 1 }], r)[0].countryCode).toBe("XK");
    expect(r.knows("jp")).toBe(true);
    expect(r.knows("QQ")).toBe(false);
    expect(r.knows(null)).toBe(false);
  });
});

describe("network rows", async () => {
  const { mapNetworkRows, networkSlug } = await import("@/server/ingest/adspyglass/map");
  it("slug matches seeded networks and sums duplicates", () => {
    expect(networkSlug("AdPulsar.io")).toBe("adpulsar");
    expect(networkSlug("Traffic Stars.com")).toBe("traffic_stars");
    expect(networkSlug("")).toBe("unknown");
    const cells = mapNetworkRows([{ name: "ExoClick.com", hits: 2, broker_income: 1 }, { name: "exoclick.com", hits: 3, broker_income: 2 }]);
    expect(cells).toEqual([{ slug: "exoclick", title: "ExoClick.com", m: expect.objectContaining({ pageLoads: 5, revenue: 3 }) }]);
  });
});

describe("device rows", async () => {
  const { mapDeviceRows } = await import("@/server/ingest/adspyglass/map");
  it("normalises names and sums", () => {
    const cells = mapDeviceRows([{ name: "Desktop", hits: 1 }, { name: "Smartphone", hits: 2 }, { name: "Mobile", hits: 3 }, { name: "Fridge", hits: 4 }]);
    expect(Object.fromEntries(cells.map((c) => [c.device, c.m.pageLoads]))).toEqual({ DESKTOP: 1, MOBILE: 5, UNKNOWN: 4 });
  });
});

describe("network side of per-site cuts", () => {
  const m = (o: Partial<Measures>): Measures => ({ pageLoads: 0, impsOwn: 0, impsNetwork: 0, clicks: 0, revenue: 0, predicted: 0, ...o });
  it("apportion splits an integer exactly by weights, largest remainder first", () => {
    expect(apportion(10, [1, 1, 1])).toEqual([4, 3, 3]);
    expect(apportion(100, [3, 1])).toEqual([75, 25]);
    expect(apportion(5, [0, 0])).toEqual([3, 2]); // no weights: even split
    expect(apportion(7, [])).toEqual([]);
    expect(apportion(3, [-1, 2])).toEqual([0, 3]);
  });
  it("allocateBroker spreads the site total by own revenue, then impressions, then loads", () => {
    const cells = [{ k: "a", m: m({ pageLoads: 10, impsOwn: 1, predicted: 3, revenue: 999 }) }, { k: "b", m: m({ pageLoads: 30, impsOwn: 3, predicted: 1, revenue: 1 }) }];
    const site = m({ revenue: 2, impsNetwork: 8 });
    expect(allocateBroker(cells, site).map((c) => [c.k, c.m.revenue, c.m.impsNetwork, c.m.pageLoads])).toEqual([["a", 1.5, 2, 10], ["b", 0.5, 6, 30]]);
    const noPredicted = cells.map((c) => ({ ...c, m: { ...c.m, predicted: 0 } }));
    expect(allocateBroker(noPredicted, site).map((c) => c.m.revenue)).toEqual([0.5, 1.5]);
    const sum = allocateBroker([1, 1, 1].map((p) => ({ m: m({ predicted: p }) })), m({ revenue: 0.01 })).reduce((a, c) => a + c.m.revenue, 0);
    expect(sum).toBeCloseTo(0.01, 10); // 4-decimal units add up exactly
    expect(allocateBroker(cells, undefined).map((c) => c.m.revenue)).toEqual([0, 0]); // ADOK has no total for the site
  });
  it("measures carries predicted_income", () => {
    expect(measures({ predicted_income: 1.25 } as never).predicted).toBe(1.25);
  });
});


describe("fields ADOK sends that used to be dropped (ADR 0016)", async () => {
  const { measures, addMeasures, mapFormatRows, optionalFields } = await import("@/server/ingest/adspyglass/map");
  it("requests, broker clicks and ADOK's fill rate are read (fraction or percent) and absent fields stay null", () => {
    const m = measures({ name: "x", hits: 100, impressions: 40, requests: 90, broker_clicks: 3, fill_rate: 44 });
    expect(m).toMatchObject({ requests: 90, brokerClicks: 3, fillRateAsg: 0.44 });
    expect(measures({ name: "x", fill_rate: 0.25 }).fillRateAsg).toBe(0.25);
    expect(measures({ name: "x" })).toMatchObject({ requests: null, brokerClicks: null, fillRateAsg: null });
    expect(optionalFields(m)).toEqual({ requests: 90, brokerClicks: 3, fillRateAsg: "0.4400", predictedIncome: null });
    expect(optionalFields(measures({ name: "x", predicted_income: 1.23456 })).predictedIncome).toBe("1.2346");
  });
  it("merged rows: counts add up, the fill rate is weighted by loads, all-null stays null", () => {
    const a = measures({ name: "a", hits: 100, requests: 10, fill_rate: 0.5 }), b = measures({ name: "b", hits: 300, requests: 20, fill_rate: 0.1 });
    expect(addMeasures(a, b)).toMatchObject({ requests: 30, brokerClicks: null, fillRateAsg: 0.2 }); // (0.5×100 + 0.1×300) / 400
    expect(addMeasures(measures({ name: "a", hits: 1 }), measures({ name: "b", hits: 2 })).fillRateAsg).toBeNull();
  });
  it("ad_type rows map to formats and duplicates are summed", () => {
    const cells = mapFormatRows([{ name: "Popunder", hits: 10, requests: 12 }, { name: "Banner 300x250", hits: 5 }, { name: "Footer banner", hits: 7 }, { ad_type: "Native", name: "?", hits: 1 }]);
    expect(Object.fromEntries(cells.map((c) => [c.format, c.m.pageLoads]))).toEqual({ POPUNDER: 10, BANNER: 12, NATIVE: 1 });
    expect(cells.find((c) => c.format === "POPUNDER")!.m.requests).toBe(12);
  });
});
