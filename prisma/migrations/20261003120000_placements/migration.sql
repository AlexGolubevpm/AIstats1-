-- Inventory: ad places on the sites and what occupies each (rotation, own deal, fix, CPA, free).
CREATE TYPE "PlacementUse" AS ENUM ('ROTATION', 'OWN_DEAL', 'FIX', 'CPA', 'FREE', 'NONE');

CREATE TABLE "Placement" (
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "Placement_pkey" PRIMARY KEY ("slug")
);

CREATE TABLE "SitePlacement" (
    "siteId" TEXT NOT NULL,
    "placementSlug" TEXT NOT NULL,
    "use" "PlacementUse" NOT NULL,
    "note" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SitePlacement_pkey" PRIMARY KEY ("siteId","placementSlug")
);

ALTER TABLE "Zone" ADD COLUMN "placementSlug" TEXT;
ALTER TABLE "Deal" ADD COLUMN "placementSlug" TEXT;

ALTER TABLE "SitePlacement" ADD CONSTRAINT "SitePlacement_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SitePlacement" ADD CONSTRAINT "SitePlacement_placementSlug_fkey" FOREIGN KEY ("placementSlug") REFERENCES "Placement"("slug") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Zone" ADD CONSTRAINT "Zone_placementSlug_fkey" FOREIGN KEY ("placementSlug") REFERENCES "Placement"("slug") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_placementSlug_fkey" FOREIGN KEY ("placementSlug") REFERENCES "Placement"("slug") ON DELETE SET NULL ON UPDATE CASCADE;
