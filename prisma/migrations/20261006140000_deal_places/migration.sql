-- A deal occupies any set of (site, place) pairs; several deals may share a cell. A cell may also
-- name the ad network that buys it.
CREATE TABLE "DealPlace" (
    "dealId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "placementSlug" TEXT NOT NULL,
    CONSTRAINT "DealPlace_pkey" PRIMARY KEY ("dealId","siteId","placementSlug")
);
CREATE INDEX "DealPlace_siteId_placementSlug_idx" ON "DealPlace"("siteId", "placementSlug");
ALTER TABLE "DealPlace" ADD CONSTRAINT "DealPlace_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DealPlace" ADD CONSTRAINT "DealPlace_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DealPlace" ADD CONSTRAINT "DealPlace_placementSlug_fkey" FOREIGN KEY ("placementSlug") REFERENCES "Placement"("slug") ON DELETE CASCADE ON UPDATE CASCADE;

-- The single place of a deal becomes that place on each of its sites.
INSERT INTO "DealPlace" ("dealId", "siteId", "placementSlug")
SELECT ds."dealId", ds."siteId", d."placementSlug" FROM "DealSite" ds JOIN "Deal" d ON d.id = ds."dealId" WHERE d."placementSlug" IS NOT NULL
ON CONFLICT DO NOTHING;

ALTER TABLE "Deal" DROP CONSTRAINT "Deal_placementSlug_fkey";
ALTER TABLE "Deal" DROP COLUMN "placementSlug";

ALTER TABLE "SitePlacement" ADD COLUMN "networkId" TEXT;
ALTER TABLE "SitePlacement" ADD CONSTRAINT "SitePlacement_networkId_fkey" FOREIGN KEY ("networkId") REFERENCES "Network"("id") ON DELETE SET NULL ON UPDATE CASCADE;

