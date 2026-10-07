import { describe, expect, it } from "vitest";
import { DEFAULT_PLACEMENTS, daysLeft, matchPlacement, placementSlug, resolvePlace, zoneTypeName, type PlaceDeal, cellText } from "@/server/domain/inventory";

describe("inventory", () => {
  it("the owner's places, the same on every site, with stable slugs", () => {
    expect(DEFAULT_PLACEMENTS.map((p) => p.slug)).toEqual(["tablink_1", "tablink_2", "tablink_3", "underplayer", "video_link_1", "video_link_2",
      "under_bar", "above_bar", "welcome_bar", "video_pause_banner", "pop", "slider", "ntv_a", "ntv_b", "footer_a", "footer_b", "footer_c", "footer_d", "outstream", "invideo", "push"]);
    expect(placementSlug("  Video pause banner ")).toBe("video_pause_banner");
  });

  it("matches zone names to places by whole words", () => {
    const places = [...DEFAULT_PLACEMENTS, { slug: "banner", title: "Banner" }];
    expect(matchPlacement("491410. Tablink 1 (site.com)", places)).toBe("tablink_1");
    expect(matchPlacement("491411. tablink-2 (site.com)", places)).toBe("tablink_2");
    expect(matchPlacement("491412. Tablink 12 (site.com)", places)).toBeNull();
    expect(matchPlacement("1. Video Pause Banner (a.com)", places)).toBe("video_pause_banner"); // longest wins over "Banner"
    expect(matchPlacement("2. Header banner 300x250 (a.com)", places)).toBe("banner");
    expect(matchPlacement("3. Popunder (a.com)", places)).toBe("pop");
  });

  it("ADOK zone names with a site prefix map onto the catalog by type", () => {
    const places = DEFAULT_PLACEMENTS;
    const cases: [string, string | null][] = [
      ["GX_NTV_A", "ntv_a"], ["GX_NTV_B", "ntv_b"], ["HS_OutStream", "outstream"], ["GXhub_Slider", "slider"], ["HS_InPP", "push"], ["HS_Slider", "slider"],
      ["491. GX_Footer_A (gayxhub.com)", "footer_a"], ["footer_1", "footer_a"], ["footer_4", "footer_d"], ["Banners_Footer_B", "footer_b"],
      ["POP player", "pop"], ["POP thumbs", "pop"], ["Popunder", "pop"], ["ntv_1", "ntv_a"], ["ntv_2", "ntv_b"], ["InVideo", "invideo"], ["Preroll_VAST", "invideo"],
      ["HS_Tablink_2", "tablink_2"], ["GX_Underplayer", "underplayer"], ["GX_Video_link_1", "video_link_1"], ["HS_Welcome_bar", "welcome_bar"],
      ["AA_AAA_aaaa", null], ["Banners_Sidebar", null],
    ];
    for (const [name, slug] of cases) expect([name, matchPlacement(name, places)]).toEqual([name, slug]);
    expect(zoneTypeName("491. GX_NTV_A (gayxhub.com)")).toBe("ntv_a");
    expect(zoneTypeName("Tablink 1")).toBe("tablink 1"); // no prefix to strip
  });

  it("a running deal wins, then the manual state, then a rotation zone; else free", () => {
    const zones = [{ name: "Tablink 1" }];
    const deal = (over: Partial<PlaceDeal>): PlaceDeal => ({ id: "d1", title: "Sponsor", advertiser: "Acme", price: "1000", basis: "флэт за период",
      startsAt: "2026-09-01", endsAt: "2026-10-31", billedVia: "DIRECT", ...over });
    const fix = resolvePlace({ deals: [deal({})], manual: { use: "CPA", note: null }, zones });
    expect(fix).toMatchObject({ use: "FIX", by: "deal", label: "Acme — Sponsor" });
    expect(fix.deals[0]).toMatchObject({ advertiser: "Acme", price: "1000", endsAt: "2026-10-31" });
    expect(resolvePlace({ deals: [deal({ id: "d2", title: "Own", billedVia: "VIA_ASG" })], zones }).use).toBe("OWN_DEAL");
    expect(resolvePlace({ deals: [], manual: { use: "CPA", note: "offer X" }, zones })).toMatchObject({ use: "CPA", by: "manual", label: "offer X" });
    expect(resolvePlace({ deals: [], zones })).toMatchObject({ use: "ROTATION", by: "zone" });
    expect(resolvePlace({ deals: [], zones: [] })).toMatchObject({ use: "FREE", by: "default" });
    const net = { id: "n", slug: "exo", title: "ExoClick" };
    expect(resolvePlace({ deals: [], manual: { use: "OWN_DEAL", note: null, network: net }, zones })).toMatchObject({ use: "OWN_DEAL", by: "manual", label: "ExoClick", network: net });
    expect(resolvePlace({ deals: [], manual: { use: "ROTATION", note: "by hand", network: net }, zones }).label).toBe("by hand");
  });

  it("cell text: money, then one advertiser or a count of deals, then the network, then the state", () => {
    const short = { ROTATION: "ASG", OWN_DEAL: "Own", FIX: "Фикс", CPA: "CPA", FREE: "свободно", NONE: "—" } as const;
    const d = (id: string): PlaceDeal => ({ id, title: "T", advertiser: `Adv ${id}`, price: "1", basis: "", startsAt: "2026-09-01", endsAt: null, billedVia: "DIRECT" });
    const cell = resolvePlace({ deals: [d("1")], zones: [] });
    expect(cellText(cell, "$5", short)).toBe("$5");
    expect(cellText(cell, null, short)).toBe("Adv 1");
    expect(cellText(resolvePlace({ deals: [d("1"), d("2")], zones: [] }), null, short)).toBe("2 фикс-дила");
    expect(cellText(resolvePlace({ deals: [], manual: { use: "ROTATION", note: null, network: { id: "n", slug: "x", title: "Net" } }, zones: [] }), null, short)).toBe("Net");
    expect(cellText(resolvePlace({ deals: [], zones: [] }), null, short)).toBe("свободно");
  });

  it("days left: whole days, null when open-ended, negative after the end", () => {
    expect(daysLeft("2026-10-09", "2026-10-02")).toBe(7);
    expect(daysLeft("2026-10-02", "2026-10-02")).toBe(0);
    expect(daysLeft("2026-09-30", "2026-10-02")).toBe(-2);
    expect(daysLeft(null, "2026-10-02")).toBeNull();
  });
});
