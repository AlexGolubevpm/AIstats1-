import { beforeEach, describe, expect, it } from "vitest";
import { buildNetwork, D1 } from "@tests/factories/network";
import {
  addCostRate, addSitesToBundle, mapAlias, missingAsgSites, saveBundle, saveNetwork, saveSite, setBundleSites, setSitesStatus, sitesWithoutRates,
} from "@/server/services/settings";
import { resetDb, testDb } from "./helpers";

const db = testDb();
let net: Awaited<ReturnType<typeof buildNetwork>>;
beforeEach(async () => { await resetDb(); net = await buildNetwork(db); });

describe("sites", () => {
  it("normalises the domain and validates ids", async () => {
    const id = await saveSite(db, { domain: "https://WWW.New-Tube.com/", adsgSiteId: 77 });
    expect((await db.site.findUniqueOrThrow({ where: { id } })).domain).toBe("new-tube.com");
    await expect(saveSite(db, { domain: "new-tube.com", adsgSiteId: 78 })).rejects.toMatchObject({ field: "domain" });
    await expect(saveSite(db, { domain: "x.com" })).rejects.toMatchObject({ field: "adsgSiteId" });
    await expect(saveSite(db, { domain: "y.com", adsgSiteId: 1 })).rejects.toMatchObject({ code: "adsg_taken" });
    await expect(saveSite(db, { domain: "z.com", metrikaId: "12ab" })).rejects.toMatchObject({ field: "metrikaId" });
  });

  it("bulk status and bundle membership", async () => {
    expect(await setSitesStatus(db, ["s1", "s2"], "PAUSED")).toBe(2);
    expect(await addSitesToBundle(db, ["s1", "s3"], net.hentai.id)).toBe(1); // s3 already there
    await setBundleSites(db, net.jav.id, ["s3"]);
    expect((await db.bundleSite.findMany({ where: { bundleId: net.jav.id } })).map((x) => x.siteId)).toEqual(["s3"]);
  });

  it("finds AdSpyglass sites that are not added yet", async () => {
    const rows = [{ name: "1. one.test" }, { name: "500. www.fresh.test" }, { name: "garbage" }];
    expect(await missingAsgSites(db, rows)).toEqual([{ adsgSiteId: 500, domain: "fresh.test" }]);
  });
});

describe("bundles", () => {
  it("validates slug and colour", async () => {
    await expect(saveBundle(db, { slug: "Jav", title: "x", color: "#000000" })).rejects.toMatchObject({ code: "slug_taken" });
    await expect(saveBundle(db, { slug: "new one", title: "x", color: "#000000" })).rejects.toMatchObject({ field: "slug" });
    await expect(saveBundle(db, { slug: "gay", title: "Gay", color: "red" })).rejects.toMatchObject({ field: "color" });
    expect(await saveBundle(db, { slug: "gay", title: "Gay", color: "#14b8a6" })).toBeTruthy();
  });
});

describe("cost rates", () => {
  it("a new rate with the same scope closes the previous one", async () => {
    const a = await addCostRate(db, { sourceSlug: "tubecrown", rateModel: "CPU", rate: "0.004", validFrom: "2026-09-01" });
    const b = await addCostRate(db, { sourceSlug: "tubecrown", rateModel: "CPU", rate: "0.005", validFrom: "2026-09-15" });
    expect(b.closed).toBe(1);
    expect((await db.costRate.findUniqueOrThrow({ where: { id: a.id } })).validTo?.toISOString().slice(0, 10)).toBe("2026-09-14");
    // a different scope is untouched
    const c = await addCostRate(db, { sourceSlug: "tubecrown", siteId: "s1", rateModel: "CPU", rate: "0.01", validFrom: "2026-09-20" });
    expect(c.closed).toBe(0);
    await expect(addCostRate(db, { sourceSlug: "nope", rateModel: "CPU", rate: "1", validFrom: "2026-09-01" })).rejects.toMatchObject({ field: "sourceSlug" });
    await expect(addCostRate(db, { sourceSlug: "tubecrown", rateModel: "CPU", rate: "-1", validFrom: "2026-09-01" })).rejects.toMatchObject({ field: "rate" });
  });

  it("warns about active sites with traffic and no rate", async () => {
    expect(await sitesWithoutRates(db, "2026-09-22")).toEqual(["one.test", "three.test", "two.test"]);
    await addCostRate(db, { sourceSlug: "tubecrown", rateModel: "CPU", rate: "0.004", validFrom: "2026-01-01" });
    expect(await sitesWithoutRates(db, "2026-09-22")).toEqual([]);
  });
});

describe("networks", () => {
  it("caps coloured networks and keeps own_deals green", async () => {
    for (let i = 0; i < 6; i++) await db.network.create({ data: { slug: `n${i}`, title: `N${i}`, color: "#999999", showInLegend: i < 5 } });
    const extra = await db.network.findUniqueOrThrow({ where: { slug: "n5" } });
    await db.network.updateMany({ where: { slug: { notIn: ["n0", "n1", "n2", "n3", "n4", "own_deals", "asg_all"] } }, data: { showInLegend: false } });
    await db.network.update({ where: { slug: "adpulsar" }, data: { showInLegend: true } });
    await expect(saveNetwork(db, { id: extra.id, title: "N5", color: "#123456", kind: "MEDIATED", showInLegend: true })).rejects.toMatchObject({ field: "showInLegend" });
    await saveNetwork(db, { id: net.own.id, title: "Own", color: "#FF0000", kind: "DIRECT", showInLegend: true });
    expect((await db.network.findUniqueOrThrow({ where: { id: net.own.id } })).color).not.toBe("#FF0000");
  });
});

describe("geo aliases", () => {
  it("maps an unresolved name and removes it from the list", async () => {
    await db.unresolvedAlias.create({ data: { source: "adspyglass", raw: "Atlantis", rows: 3 } });
    await expect(mapAlias(db, "adspyglass", "Atlantis", "QQ")).rejects.toMatchObject({ field: "countryCode" });
    await mapAlias(db, "adspyglass", "Atlantis", "gr");
    expect(await db.unresolvedAlias.count()).toBe(0);
    expect((await db.countryAlias.findUniqueOrThrow({ where: { source_raw: { source: "adspyglass", raw: "Atlantis" } } })).countryCode).toBe("GR");
    void D1;
  });
});
