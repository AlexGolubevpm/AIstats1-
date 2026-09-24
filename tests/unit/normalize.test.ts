import { describe, expect, it } from "vitest";
import {
  CountryResolver, SEED_ALIASES, guessPosition, normalizeDevice, normalizeDomain, normalizeFormat,
  parseSpotName, parseWebsiteName,
} from "@/server/ingest/normalize";

const countries = [
  { code: "JP", nameEn: "Japan", nameRu: "Япония" }, { code: "JO", nameEn: "Jordan" },
  { code: "AX", nameEn: "Åland Islands" }, { code: "US", nameEn: "United States" }, { code: "GB", nameEn: "United Kingdom" },
];
const aliases = [...SEED_ALIASES.map((a) => ({ ...a, source: "*" })), { raw: "Japon", source: "adspyglass", countryCode: "JP" }];

describe("CountryResolver", () => {
  it("resolves codes, names, aliases", () => {
    const r = new CountryResolver(countries, aliases);
    expect(r.resolve("jp", "metrika")).toBe("JP");
    expect(r.resolve("Japan", "adspyglass")).toBe("JP");
    expect(r.resolve("Япония", "metrika")).toBe("JP");
    expect(r.resolve("Hashemite Kingdom of Jordan", "adspyglass")).toBe("JO");
    expect(r.resolve("Aland", "adspyglass")).toBe("AX"); // diacritics folded
    expect(r.resolve("  united   states ", "csv")).toBe("US");
    expect(r.resolve("Japon", "adspyglass")).toBe("JP");
  });
  it("source-specific aliases do not leak to other sources", () => {
    const r = new CountryResolver(countries, aliases);
    expect(r.resolve("Japon", "metrika")).toBe("XX");
  });
  it("unknown values go to XX and are counted", () => {
    const r = new CountryResolver(countries, aliases);
    expect(r.resolve("Atlantis", "adspyglass")).toBe("XX");
    expect(r.resolve("Atlantis", "adspyglass")).toBe("XX");
    expect(r.resolve("", "adspyglass")).toBe("XX");
    expect(r.unresolved.get("adspyglass:Atlantis")?.rows).toBe(2);
    expect(r.unresolved.size).toBe(2);
  });
});

describe("normalizers", () => {
  it("devices", () => {
    expect(normalizeDevice("Desktop")).toBe("DESKTOP");
    expect(normalizeDevice("phone")).toBe("MOBILE");
    expect(normalizeDevice("Smart TV")).toBe("TV");
    expect(normalizeDevice("fridge")).toBe("UNKNOWN");
    expect(normalizeDevice(undefined)).toBe("UNKNOWN");
  });
  it("formats", () => {
    expect(normalizeFormat("Popunder")).toBe("POPUNDER");
    expect(normalizeFormat("In-Page Push")).toBe("INPAGEPUSH");
    expect(normalizeFormat("Banners_Footer_A")).toBe("BANNER");
    expect(normalizeFormat("VAST preroll")).toBe("INVIDEO");
    expect(normalizeFormat("Native")).toBe("NATIVE");
    expect(normalizeFormat("weird")).toBe("OTHER");
  });
  it("parses ASG names", () => {
    expect(parseWebsiteName("137648. WWW.Japan-Tube.com")).toEqual({ id: 137648, domain: "japan-tube.com" });
    expect(parseWebsiteName("site.com")).toEqual({ id: null, domain: "site.com" });
    expect(parseSpotName("491410. Banners_Footer_A (japan-tube.com)")).toEqual({ id: 491410, name: "Banners_Footer_A", domain: "japan-tube.com" });
    expect(parseSpotName("12. Slider")).toEqual({ id: 12, name: "Slider", domain: null });
  });
  it("domains and positions", () => {
    expect(normalizeDomain("https://www.Site.com/path")).toBe("site.com");
    expect(guessPosition("Banners_Footer_A")).toBe("footer");
    expect(guessPosition("Popunder")).toBeNull();
  });
});
