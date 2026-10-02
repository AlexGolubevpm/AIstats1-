import { describe, expect, it } from "vitest";
import { DEFAULT_PLACEMENTS, matchPlacement, placementSlug, resolvePlace } from "@/server/domain/inventory";

describe("inventory", () => {
  it("the owner's ten places, with stable slugs", () => {
    expect(DEFAULT_PLACEMENTS.map((p) => p.slug)).toEqual(["tablink_1", "tablink_2", "tablink_3", "underplayer", "video_link_1", "video_link_2",
      "under_bar", "above_bar", "welcome_bar", "video_pause_banner"]);
    expect(placementSlug("  Video pause banner ")).toBe("video_pause_banner");
  });

  it("matches zone names to places by whole words", () => {
    const places = [...DEFAULT_PLACEMENTS, { slug: "banner", title: "Banner" }];
    expect(matchPlacement("491410. Tablink 1 (site.com)", places)).toBe("tablink_1");
    expect(matchPlacement("491411. tablink-2 (site.com)", places)).toBe("tablink_2");
    expect(matchPlacement("491412. Tablink 12 (site.com)", places)).toBeNull();
    expect(matchPlacement("1. Video Pause Banner (a.com)", places)).toBe("video_pause_banner"); // longest wins over "Banner"
    expect(matchPlacement("2. Header banner 300x250 (a.com)", places)).toBe("banner");
    expect(matchPlacement("3. Popunder (a.com)", places)).toBeNull();
  });

  it("a running deal wins, then the manual state, then a rotation zone; else free", () => {
    const zones = [{ name: "Tablink 1" }];
    expect(resolvePlace({ deals: [{ id: "d1", title: "Sponsor", billedVia: "DIRECT" }], manual: { use: "CPA", note: null }, zones }))
      .toEqual({ use: "FIX", by: "deal", label: "Sponsor", dealIds: ["d1"] });
    expect(resolvePlace({ deals: [{ id: "d2", title: "Own", billedVia: "VIA_ASG" }], zones }).use).toBe("OWN_DEAL");
    expect(resolvePlace({ deals: [], manual: { use: "CPA", note: "offer X" }, zones })).toMatchObject({ use: "CPA", by: "manual", label: "offer X" });
    expect(resolvePlace({ deals: [], zones })).toMatchObject({ use: "ROTATION", by: "zone" });
    expect(resolvePlace({ deals: [], zones: [] })).toMatchObject({ use: "FREE", by: "default" });
  });
});
