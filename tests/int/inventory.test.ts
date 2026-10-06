import { beforeEach, describe, expect, it } from "vitest";
import { RuleError } from "@/server/domain/errors";
import { attachableDeals, inventoryDeals, inventoryGrid } from "@/server/queries/inventory";
import { cellText, type PlaceUse } from "@/server/domain/inventory";
import { seedReference } from "@/server/seed/reference";
import { saveDeal } from "@/server/services/deals";
import { addPlacement, attachDealPlaces, detachDealPlace, matchZonesToPlacements, setPlacementUse, setZonePlacement } from "@/server/services/inventory";
import { resetDb, testDb } from "./helpers";

const db = testDb();
const TODAY = "2026-10-02";
const SHORT: Record<PlaceUse, string> = { ROTATION: "ASG", OWN_DEAL: "Own", FIX: "Фикс", CPA: "CPA", FREE: "свободно", NONE: "—" };

beforeEach(async () => {
  await resetDb();
  await seedReference(db);
  await db.site.create({ data: { id: "a", domain: "alpha.test", title: "Alpha" } });
  await db.site.create({ data: { id: "b", domain: "beta.test", title: "Beta" } });
});

/** `placementSlug` is a shortcut: that place on every site of the deal. */
const deal = ({ placementSlug, ...over }: Record<string, unknown> & { placementSlug?: string }) => {
  const siteIds = (over.siteIds as string[] | undefined) ?? ["a"];
  return saveDeal(db, {
    title: "Sponsor", advertiser: "Acme", paymentBasis: "FLAT_PERIOD", price: "1000", siteIds, geoScope: [], geoExclude: false,
    startsAt: "2026-09-01", endsAt: null, billingPeriod: "MONTH", paymentTermsDays: 30, counterSource: "MANUAL", billedVia: "DIRECT",
    places: placementSlug ? siteIds.map((siteId) => ({ siteId, placementSlug })) : [], ...over,
  } as never);
};

describe("inventory", () => {
  it("every site has the owner's ten places, all free at first", async () => {
    const g = await inventoryGrid(TODAY);
    expect(g.places.map((p) => p.title)).toEqual(["Tablink 1", "Tablink 2", "Tablink 3", "Underplayer", "Video link 1", "Video link 2",
      "Under bar", "Above bar", "Welcome bar", "Video pause banner"]);
    expect(g.sites.map((s) => [s.domain, s.free])).toEqual([["alpha.test", 10], ["beta.test", 10]]);
    expect(g.places.every((p) => p.free === 2)).toBe(true);
  });

  it("a fix deal, an own deal in ASG, a rotation zone and a manual CPA occupy their places", async () => {
    await deal({ placementSlug: "welcome_bar" });
    await deal({ title: "Own", billedVia: "VIA_ASG", placementSlug: "tablink_1", siteIds: ["a", "b"] });
    await db.zone.create({ data: { adsgZoneId: 1, siteId: "b", name: "Under bar", format: "BANNER" } });
    await matchZonesToPlacements(db);
    await setPlacementUse(db, "b", "video_pause_banner", "CPA", "offer X");
    await setPlacementUse(db, "a", "underplayer", "NONE");
    const g = await inventoryGrid(TODAY);
    const a = g.sites.find((s) => s.id === "a")!.cells, b = g.sites.find((s) => s.id === "b")!.cells;
    expect([a.welcome_bar.use, a.welcome_bar.label, a.tablink_1.use, b.tablink_1.use]).toEqual(["FIX", "Acme — Sponsor", "OWN_DEAL", "OWN_DEAL"]);
    expect(a.welcome_bar.deals[0]).toMatchObject({ advertiser: "Acme", price: "1000", basis: "флэт за период", startsAt: "2026-09-01", endsAt: null, billedVia: "DIRECT" });
    expect([b.under_bar.use, b.under_bar.by, b.video_pause_banner.use, b.video_pause_banner.label, a.underplayer.use])
      .toEqual(["ROTATION", "zone", "CPA", "offer X", "NONE"]);
    expect(g.places.find((p) => p.slug === "tablink_1")!.free).toBe(0);
    expect(g.sites.find((s) => s.id === "a")!.free).toBe(7);
  });

  it("a deal takes different places on different sites; two deals share a cell; attach and detach from the grid", async () => {
    const tiers = await deal({ title: "Tier 1", places: [{ siteId: "a", placementSlug: "tablink_1" }, { siteId: "b", placementSlug: "underplayer" }], siteIds: ["a", "b"] });
    const t2 = await deal({ title: "Tier 2", billedVia: "VIA_ASG", places: [{ siteId: "a", placementSlug: "tablink_1" }] });
    let g = await inventoryGrid(TODAY);
    let a = g.sites.find((s) => s.id === "a")!.cells, b = g.sites.find((s) => s.id === "b")!.cells;
    expect([a.tablink_1.use, a.tablink_1.deals.map((d) => d.title).sort(), a.underplayer.use, b.tablink_1.use, b.underplayer.use])
      .toEqual(["FIX", ["Tier 1", "Tier 2"], "FREE", "FREE", "FIX"]);
    expect(cellText(a.tablink_1, null, SHORT)).toBe("2 фикс-дила");
    expect(cellText(b.underplayer, null, SHORT)).toBe("Acme");
    // Attach from the cell: the deal joins the site if it was not there yet.
    expect(await attachDealPlaces(db, "b", "tablink_2", [t2, tiers])).toBe(2);
    expect((await db.dealSite.findMany({ where: { dealId: t2 } })).map((x) => x.siteId).sort()).toEqual(["a", "b"]);
    await detachDealPlace(db, "a", "tablink_1", t2);
    g = await inventoryGrid(TODAY);
    a = g.sites.find((s) => s.id === "a")!.cells; b = g.sites.find((s) => s.id === "b")!.cells;
    expect([a.tablink_1.deals.map((d) => d.title), b.tablink_2.deals.map((d) => d.title).sort()]).toEqual([["Tier 1"], ["Tier 1", "Tier 2"]]);
    expect((await inventoryDeals(TODAY)).find((d) => d.id === tiers)!.placements).toEqual(["Tablink 1", "Tablink 2", "Underplayer"]);
    expect((await attachableDeals()).map((d) => d.title).sort()).toEqual(["Tier 1", "Tier 2"]);
    await expect(attachDealPlaces(db, "a", "tablink_1", [])).rejects.toBeInstanceOf(RuleError);
    await expect(attachDealPlaces(db, "a", "nope", [tiers])).rejects.toBeInstanceOf(RuleError);
    await expect(attachDealPlaces(db, "a", "tablink_1", ["ghost"])).rejects.toBeInstanceOf(RuleError);
  });

  it("a network that buys the place: own deal for a direct network, rotation for a mediated one; the label is the network", async () => {
    const direct = await db.network.create({ data: { slug: "exo", title: "ExoClick", color: "#000", kind: "DIRECT" } });
    const mediated = await db.network.findFirstOrThrow({ where: { kind: "MEDIATED" } });
    await setPlacementUse(db, "a", "tablink_3", "AUTO", null, direct.id);
    await setPlacementUse(db, "b", "tablink_3", "AUTO", "sold by hand", mediated.id);
    await setPlacementUse(db, "b", "above_bar", "CPA", null, direct.id);
    let g = await inventoryGrid(TODAY);
    let a = g.sites.find((s) => s.id === "a")!.cells, b = g.sites.find((s) => s.id === "b")!.cells;
    expect([a.tablink_3.use, a.tablink_3.by, a.tablink_3.label, a.tablink_3.network?.slug]).toEqual(["OWN_DEAL", "manual", "ExoClick", "exo"]);
    expect([b.tablink_3.use, b.tablink_3.label, b.above_bar.use, b.above_bar.network?.title]).toEqual(["ROTATION", "sold by hand", "CPA", "ExoClick"]);
    expect(cellText(a.tablink_3, null, SHORT)).toBe("ExoClick");
    await setPlacementUse(db, "a", "tablink_3", "AUTO", null, null); // network removed → back to auto
    g = await inventoryGrid(TODAY);
    expect(g.sites.find((s) => s.id === "a")!.cells.tablink_3.use).toBe("FREE");
    await expect(setPlacementUse(db, "a", "tablink_3", "AUTO", null, "ghost")).rejects.toBeInstanceOf(RuleError);
  });

  it("the deal's format follows the zones mapped to its places; else OTHER", async () => {
    await db.zone.create({ data: { adsgZoneId: 31, siteId: "a", name: "Tablink 1", format: "NATIVE" } });
    await db.zone.create({ data: { adsgZoneId: 32, siteId: "a", name: "Under bar", format: "BANNER" } });
    await matchZonesToPlacements(db);
    const one = await deal({ placementSlug: "tablink_1" });
    const mixed = await deal({ title: "Mixed", places: [{ siteId: "a", placementSlug: "tablink_1" }, { siteId: "a", placementSlug: "under_bar" }] });
    const none = await deal({ title: "None" });
    expect((await db.deal.findMany({ where: { id: { in: [one, mixed, none] } } })).map((d) => [d.title, d.format]).sort()).toEqual([["Mixed", "OTHER"], ["None", "OTHER"], ["Sponsor", "NATIVE"]]);
    // Editing keeps the previous format when the places no longer point at one format.
    await saveDeal(db, { title: "Sponsor", advertiser: "Acme", paymentBasis: "FLAT_PERIOD", price: "1000", siteIds: ["a"], geoScope: [], geoExclude: false,
      startsAt: "2026-09-01", endsAt: null, billingPeriod: "MONTH", paymentTermsDays: 30, counterSource: "MANUAL", billedVia: "DIRECT", places: [] } as never, one);
    expect((await db.deal.findUniqueOrThrow({ where: { id: one } })).format).toBe("NATIVE");
    expect(await db.auditLog.count({ where: { entityId: one, field: "places" } })).toBe(1);
  });

  it("an ended deal frees the place; AUTO removes a manual state", async () => {
    await deal({ placementSlug: "above_bar", endsAt: "2026-09-30" });
    await setPlacementUse(db, "a", "under_bar", "CPA");
    await setPlacementUse(db, "a", "under_bar", "AUTO");
    const a = (await inventoryGrid(TODAY)).sites.find((s) => s.id === "a")!.cells;
    expect([a.above_bar.use, a.under_bar.use]).toEqual(["FREE", "FREE"]);
  });

  it("adding a place maps existing zones by name; validation", async () => {
    await db.zone.create({ data: { adsgZoneId: 2, siteId: "a", name: "Header banner 300x250", format: "BANNER" } });
    expect(await addPlacement(db, "Header banner")).toBe("header_banner");
    expect((await db.zone.findUniqueOrThrow({ where: { adsgZoneId: 2 } })).placementSlug).toBe("header_banner");
    await expect(addPlacement(db, "header  banner")).rejects.toBeInstanceOf(RuleError);
    await expect(addPlacement(db, " ")).rejects.toBeInstanceOf(RuleError);
    await expect(setPlacementUse(db, "a", "tablink_1", "BOGUS")).rejects.toBeInstanceOf(RuleError);
    await expect(deal({ placementSlug: "nope" })).rejects.toThrow(/Место не найдено/);
    await expect(deal({ places: [{ siteId: "b", placementSlug: "tablink_1" }] })).rejects.toThrow(/нет в диле/);
  });

  it("the deals table: every running deal, with or without a place, ending soonest first; recently ended greyed", async () => {
    await deal({ title: "Soon", placementSlug: "welcome_bar", endsAt: "2026-10-05" });
    await deal({ title: "Open", siteIds: ["a", "b"] }); // no place, no end
    await deal({ title: "Later", placementSlug: "tablink_1", endsAt: "2026-11-01" });
    const endedId = await deal({ title: "Done", placementSlug: "tablink_2", endsAt: "2026-09-20" });
    await db.deal.update({ where: { id: endedId }, data: { status: "ENDED" } });
    const oldId = await deal({ title: "Old", startsAt: "2026-07-01", endsAt: "2026-08-01" });
    await db.deal.update({ where: { id: oldId }, data: { status: "ENDED" } });
    const rows = await inventoryDeals(TODAY);
    expect(rows.map((r) => [r.title, r.placements, r.daysLeft, r.status])).toEqual([
      ["Soon", ["Welcome bar"], 3, "ACTIVE"], ["Later", ["Tablink 1"], 30, "ACTIVE"], ["Open", [], null, "ACTIVE"], ["Done", ["Tablink 2"], -12, "ENDED"]]);
    expect(rows[2]).toMatchObject({ advertiser: "Acme", sites: ["alpha.test", "beta.test"], price: 1000, basis: "флэт за период", startsAt: "2026-09-01", endsAt: null });
  });
});

describe("inventory revenue, bundles and zone mapping", () => {
  const fact = (siteId: string, zoneId: string, date: string, revenue: string, imps = 100) =>
    db.factRevenueZone.create({ data: { date: new Date(`${date}T00:00:00Z`), siteId, zoneId, format: "BANNER", revenueReported: revenue, impsOwn: imps } });
  const fix = (dealId: string, siteId: string, date: string, revenue: string) =>
    db.factFixDeal.create({ data: { date: new Date(`${date}T00:00:00Z`), dealId, siteId, countryCode: "ZZ", revenue } });

  it("a cell carries the period revenue of the zones mapped to it; row, column and network totals add up", async () => {
    const z1 = await db.zone.create({ data: { adsgZoneId: 11, siteId: "a", name: "Under bar", format: "BANNER" } });
    const z2 = await db.zone.create({ data: { adsgZoneId: 12, siteId: "a", name: "AA_AAA_aaaa", format: "POPUNDER" } }); // no place by name
    const z3 = await db.zone.create({ data: { adsgZoneId: 13, siteId: "b", name: "Under bar", format: "BANNER" } });
    await matchZonesToPlacements(db);
    await fact("a", z1.id, "2026-10-01", "10.5");
    await fact("a", z1.id, "2026-09-25", "99"); // outside the 7-day window
    await fact("a", z2.id, "2026-10-01", "7");
    await fact("b", z3.id, "2026-09-30", "4.25", 40);
    const g = await inventoryGrid(TODAY);
    const a = g.sites.find((s) => s.id === "a")!, b = g.sites.find((s) => s.id === "b")!;
    expect([a.cells.under_bar.revenue, a.cells.under_bar.imps, a.cells.under_bar.use]).toEqual([10.5, 100, "ROTATION"]);
    expect([a.revenue, a.unmapped, b.revenue]).toEqual([10.5, 1, 4.25]); // the unmapped zone's money is in no cell
    expect(g.places.find((p) => p.slug === "under_bar")!.revenue).toBe(14.75);
    expect(g.revenue).toBe(14.75);
    expect(a.zones.map((z) => [z.name, z.placementSlug, z.revenue])).toEqual([["AA_AAA_aaaa", null, 7], ["Under bar", "under_bar", 10.5]]);
    // An explicit period moves the window.
    const g2 = await inventoryGrid(TODAY, { from: "2026-09-25", to: "2026-09-25" });
    expect(g2.sites.find((s) => s.id === "a")!.cells.under_bar.revenue).toBe(99);
  });

  it("fix deals with a place add their facts to the cell, direct and via ASG alike (own deals are not in the zone cut); two places split the site's facts", async () => {
    const direct = await deal({ placementSlug: "welcome_bar" });
    const own = await deal({ title: "Own", billedVia: "VIA_ASG", placementSlug: "tablink_1" });
    const two = await deal({ title: "Two", places: [{ siteId: "a", placementSlug: "tablink_2" }, { siteId: "a", placementSlug: "tablink_3" }] });
    await db.factFixDeal.deleteMany();
    await fix(direct, "a", "2026-10-01", "33.3333");
    await fix(own, "a", "2026-10-01", "50");
    await fix(two, "a", "2026-10-01", "10");
    const a = (await inventoryGrid(TODAY)).sites.find((s) => s.id === "a")!;
    expect([a.cells.welcome_bar.use, a.cells.welcome_bar.revenue, a.cells.tablink_1.use, a.cells.tablink_1.revenue]).toEqual(["FIX", 33.3333, "OWN_DEAL", 50]);
    expect([a.cells.tablink_2.revenue, a.cells.tablink_3.revenue, Math.round(a.revenue * 1e4) / 1e4]).toEqual([5, 5, 93.3333]);
  });

  it("mapping a zone by hand moves its revenue into the place and survives the nightly name matching", async () => {
    const z = await db.zone.create({ data: { adsgZoneId: 21, siteId: "a", name: "AA_AAA_aaaa", format: "POPUNDER" } });
    await fact("a", z.id, "2026-10-01", "7");
    await setZonePlacement(db, z.id, "video_link_2");
    await matchZonesToPlacements(db);
    let a = (await inventoryGrid(TODAY)).sites.find((s) => s.id === "a")!;
    expect([a.cells.video_link_2.use, a.cells.video_link_2.revenue, a.unmapped]).toEqual(["ROTATION", 7, 0]);
    await setZonePlacement(db, z.id, null);
    a = (await inventoryGrid(TODAY)).sites.find((s) => s.id === "a")!;
    expect([a.cells.video_link_2.use, a.cells.video_link_2.revenue, a.unmapped]).toEqual(["FREE", 0, 1]);
    await expect(setZonePlacement(db, z.id, "nope")).rejects.toBeInstanceOf(RuleError);
  });

  it("sites carry their bundle slugs so the page can filter and group; a site in two bundles is listed under both", async () => {
    const b1 = await db.bundle.create({ data: { slug: "tier-a", title: "Tier A", color: "#000" } });
    const b2 = await db.bundle.create({ data: { slug: "tier-b", title: "Tier B", color: "#111" } });
    await db.bundleSite.createMany({ data: [{ bundleId: b1.id, siteId: "a" }, { bundleId: b2.id, siteId: "a" }, { bundleId: b2.id, siteId: "b" }] });
    const g = await inventoryGrid(TODAY);
    expect(g.sites.map((s) => [s.domain, s.bundles])).toEqual([["alpha.test", ["tier-a", "tier-b"]], ["beta.test", ["tier-b"]]]);
  });
});
