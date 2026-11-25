-- ADR 0023: popunder revenue by country (zone-filtered country cut) and T1/T2 traffic by source (country-filtered source cut).
CREATE TABLE "FactRevenueFormatGeo" (
    "date" DATE NOT NULL,
    "siteId" TEXT NOT NULL,
    "format" "AdFormat" NOT NULL,
    "countryCode" TEXT NOT NULL,
    "pageLoads" INTEGER NOT NULL DEFAULT 0,
    "impsOwn" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "revenueReported" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "predictedIncome" DECIMAL(12,4),
    CONSTRAINT "FactRevenueFormatGeo_pkey" PRIMARY KEY ("date","siteId","format","countryCode")
);
CREATE INDEX "FactRevenueFormatGeo_date_idx" ON "FactRevenueFormatGeo"("date");
ALTER TABLE "FactRevenueFormatGeo" ADD CONSTRAINT "FactRevenueFormatGeo_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "FactTrafficSourceTier" (
    "date" DATE NOT NULL,
    "siteId" TEXT NOT NULL,
    "sourceSlug" TEXT NOT NULL,
    "tierGroup" TEXT NOT NULL,
    "pageLoads" INTEGER NOT NULL DEFAULT 0,
    "revenueReported" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "predictedIncome" DECIMAL(12,4),
    CONSTRAINT "FactTrafficSourceTier_pkey" PRIMARY KEY ("date","siteId","sourceSlug","tierGroup")
);
CREATE INDEX "FactTrafficSourceTier_date_idx" ON "FactTrafficSourceTier"("date");
ALTER TABLE "FactTrafficSourceTier" ADD CONSTRAINT "FactTrafficSourceTier_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FactTrafficSourceTier" ADD CONSTRAINT "FactTrafficSourceTier_sourceSlug_fkey" FOREIGN KEY ("sourceSlug") REFERENCES "CostSource"("slug") ON DELETE RESTRICT ON UPDATE CASCADE;
