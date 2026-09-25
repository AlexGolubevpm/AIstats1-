import { describe, expect, it } from "vitest";
import { mapCountryRows } from "@/server/ingest/adspyglass/map";
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
