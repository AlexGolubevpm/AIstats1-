import { describe, expect, it } from "vitest";
import countries from "../../prisma/data/countries.json";
import { DEFAULT_TIERS, TIERS, defaultTier, parseTierBulk, tierLabel } from "@/server/domain/tiers";
import { geoScopeLabel, inGeoScope, parseGeoInput } from "@/server/domain/deals";
import { geoBelowNetwork } from "@/server/domain/hypotheses";

describe("tiers 1–5 (ADR 0017)", () => {
  it("the default map lists real ISO codes once; the seed file follows it; XX/ZZ stay 0", () => {
    const all = TIERS.flatMap((t) => DEFAULT_TIERS[t]);
    expect(new Set(all).size).toBe(all.length);
    expect(all.every((c) => /^[A-Z]{2}$/.test(c))).toBe(true);
    const known = new Set((countries as { code: string }[]).map((c) => c.code));
    expect(all.filter((c) => !known.has(c))).toEqual(["XK"]); // Kosovo is in the map but not in the seed: harmless
    for (const c of countries as { code: string; tier: number }[]) expect(c.tier).toBe(defaultTier(c.code));
    expect([defaultTier("US"), defaultTier("IT"), defaultTier("BR"), defaultTier("IN"), defaultTier("TV"), defaultTier("ZZ")]).toEqual([1, 2, 3, 4, 5, 0]);
    expect([tierLabel(3), tierLabel(0)]).toEqual(["T3", "—"]);
  });
  it("bulk paste: «T2: IT, ES; T3 BR» → codes with tiers; stray tokens and service codes are reported", () => {
    expect(parseTierBulk("T2: IT, ES; T3 br mx")).toEqual({ tiers: { IT: 2, ES: 2, BR: 3, MX: 3 }, bad: [] });
    expect(parseTierBulk("IT T1 US").bad).toEqual(["IT"]); // a code before any tier
    expect(parseTierBulk("T9: IT").bad).toEqual(["T9", "IT"]);
    expect(parseTierBulk("T1: ZZ, USA")).toEqual({ tiers: {}, bad: ["ZZ", "USA"] });
    expect(parseTierBulk("T1: JP\nT2: JP").tiers).toEqual({ JP: 2 }); // the last wins
  });
});

describe("deal geo scope by tier", () => {
  const tierOf = (c: string) => ({ US: 1, JP: 1, IT: 2, BR: 3 } as Record<string, number>)[c];
  it("a country is in scope when listed or of a listed tier; «все, кроме» inverts; nothing listed = everything", () => {
    const d = { geoScope: ["BR"], geoExclude: false, geoTiers: [1] };
    expect(["US", "JP", "BR", "IT", "ZZ"].map((c) => inGeoScope(d, c, tierOf))).toEqual([true, true, true, false, false]);
    expect(["US", "IT"].map((c) => inGeoScope({ ...d, geoExclude: true }, c, tierOf))).toEqual([false, true]);
    expect(inGeoScope({ geoScope: [], geoExclude: false, geoTiers: [] }, "IT", tierOf)).toBe(true);
    expect(inGeoScope({ geoScope: [], geoExclude: false, geoTiers: [2] }, "IT")).toBe(false); // no tier lookup → tiers cannot match
    expect(inGeoScope({ geoScope: ["IT"], geoExclude: false }, "IT")).toBe(true); // deals from before tiers keep working
  });
  it("labels and parsing", () => {
    expect(geoScopeLabel({ geoScope: ["JP", "KR"], geoExclude: false, geoTiers: [2, 1] })).toBe("T1, T2 + JP, KR");
    expect(geoScopeLabel({ geoScope: [], geoExclude: true, geoTiers: [3] })).toBe("все, кроме T3");
    expect(geoScopeLabel({ geoScope: [], geoExclude: false })).toBe("все гео");
    expect(geoScopeLabel({ geoScope: "ABCDEFGHIJ".split("").map((x) => x + "X"), geoExclude: false }, 3)).toBe("AX, BX, CX и ещё 7");
    expect(parseGeoInput("jp, T1 kr t2 T9")).toEqual({ codes: ["JP", "KR", "T9"], tiers: [1, 2] }); // T9 is not a tier: validation rejects it as a code
  });
});

describe("geo_below_network with a tier benchmark", () => {
  const row = (siteId: string, cc: string, revenue: number, tier: number | null, pageLoads = 20_000) => ({ siteId, domain: `${siteId}.test`, countryCode: cc, revenue, pageLoads, tier });
  it("a country on fewer than 3 sites is compared with the median of its tier; a country on 3+ sites still with itself", () => {
    const rows = [
      row("s1", "JP", 40, 1), row("s2", "JP", 40, 1), row("s3", "JP", 10, 1), // JP on 3 sites: own benchmark, s3 is below
      row("s1", "US", 40, 1), row("s4", "DE", 44, 1), // US on 1 site, DE on 1 site: tier-1 benchmark over 6 pairs
      row("s4", "GB", 5, 1), // GB thin and poor → below the tier median
    ];
    const out = geoBelowNetwork(rows, 7);
    expect(out.map((o) => o.objectKey).sort()).toEqual(["site:s3|country:JP", "site:s4|country:GB"]);
    const gb = out.find((o) => o.countryCode === "GB")!, jp = out.find((o) => o.countryCode === "JP")!;
    expect(gb.evidence).toMatchObject({ benchmark: "tier", tier: 1, sites: 6 });
    expect(gb.title).toContain("по тиру T1");
    expect(jp.evidence).toMatchObject({ benchmark: "country", sites: 3 });
    // Without tiers a thin country is simply skipped, as before.
    expect(geoBelowNetwork(rows.map((r) => ({ ...r, tier: null })), 7).map((o) => o.countryCode)).toEqual(["JP"]);
  });
});
