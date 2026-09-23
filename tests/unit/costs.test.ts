import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { closePreviousRate, computeCosts, normalizeCsvDate, parseCostCsv, pickRate, type Rate } from "@/server/domain/costs";

const rate = (p: Partial<Rate>): Rate => ({
  id: Math.random().toString(36), siteId: null, countryCode: null, sourceSlug: "tubecrown",
  rateModel: "CPU", rate: "0.001", validFrom: "2026-01-01", validTo: null, ...p,
});
const cell = { date: "2026-09-10", siteId: "s1", countryCode: "JP" };

describe("pickRate", () => {
  it("prefers site+country over site over country over global", () => {
    const global = rate({ id: "g" }), country = rate({ id: "c", countryCode: "JP" });
    const site = rate({ id: "s", siteId: "s1" }), both = rate({ id: "b", siteId: "s1", countryCode: "JP" });
    expect(pickRate([global, country, site, both], cell, "tubecrown")?.id).toBe("b");
    expect(pickRate([global, country, site], cell, "tubecrown")?.id).toBe("s");
    expect(pickRate([global, country], cell, "tubecrown")?.id).toBe("c");
    expect(pickRate([global], cell, "tubecrown")?.id).toBe("g");
  });
  it("respects validity window and source", () => {
    expect(pickRate([rate({ validFrom: "2026-09-11" })], cell, "tubecrown")).toBeNull();
    expect(pickRate([rate({ validTo: "2026-09-09" })], cell, "tubecrown")).toBeNull();
    expect(pickRate([rate({})], cell, "tubetraffic")).toBeNull();
    expect(pickRate([rate({ id: "old" }), rate({ id: "new", validFrom: "2026-09-01" })], cell, "tubecrown")?.id).toBe("new");
  });
});

describe("computeCosts", () => {
  it("CPU and CPM", () => {
    const cells = [{ ...cell, uniques: 2000 }];
    expect(computeCosts(cells, [rate({ rateModel: "CPU", rate: "0.002" })], "tubecrown")[0].cost.toString()).toBe("4");
    expect(computeCosts(cells, [rate({ rateModel: "CPM", rate: "1.5" })], "tubecrown")[0].cost.toString()).toBe("3");
  });
  it("FLAT is spread by uniques and sums exactly to the daily amount", () => {
    const cells = [
      { ...cell, countryCode: "JP", uniques: 1 }, { ...cell, countryCode: "US", uniques: 1 }, { ...cell, countryCode: "DE", uniques: 1 },
    ];
    const rows = computeCosts(cells, [rate({ rateModel: "FLAT", rate: "10", siteId: "s1" })], "tubecrown");
    expect(rows).toHaveLength(3);
    expect(rows.reduce((a, r) => a.add(r.cost), new Decimal(0)).toString()).toBe("10");
  });
  it("skips cells without a rate", () => {
    expect(computeCosts([{ ...cell, uniques: 5 }], [], "tubecrown")).toEqual([]);
  });
});

describe("closePreviousRate", () => {
  it("closes an open rate of the same scope the day before", () => {
    const existing = [rate({ id: "a", siteId: "s1" }), rate({ id: "b" })];
    expect(closePreviousRate(existing, { siteId: "s1", countryCode: null, sourceSlug: "tubecrown", validFrom: "2026-10-01" }))
      .toEqual([{ id: "a", validTo: "2026-09-30" }]);
  });
});

describe("parseCostCsv", () => {
  it("parses rows and reports errors per line", () => {
    const csv = "date;domain;country;source;uniques;cost\n2026-09-01;WWW.a.com;JP;TubeCrown;1 000;12,5\n01.09.2026;b.com;US;tubecrown;x;1\n";
    const { rows, errors } = parseCostCsv(csv);
    expect(rows).toEqual([{ date: "2026-09-01", domain: "a.com", country: "JP", source: "tubecrown", uniques: 1000, cost: 12.5 }]);
    expect(errors).toEqual([{ line: 3, reason: "Уники или сумма — не число" }]);
  });
  it("requires columns", () => {
    expect(parseCostCsv("date,domain\n").errors[0].reason).toContain("uniques");
  });
  it("normalizes dates", () => {
    expect(normalizeCsvDate("5/9/2026")).toBe("2026-09-05");
    expect(normalizeCsvDate("2026/09/05")).toBeNull();
  });
});
