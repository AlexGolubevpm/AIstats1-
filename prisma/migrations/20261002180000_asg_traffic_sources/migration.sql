-- ADOK traffic sources: volume and revenue per site and source; their revenue × revShare is the cost.
ALTER TYPE "RateModel" ADD VALUE 'REVSHARE';
ALTER TYPE "CostOrigin" ADD VALUE 'ASG';

ALTER TABLE "CostSource" ADD COLUMN "revShare" DECIMAL(5,4) NOT NULL DEFAULT 1,
                         ADD COLUMN "asgName" TEXT;
CREATE UNIQUE INDEX "CostSource_asgName_key" ON "CostSource"("asgName");

CREATE TABLE "FactTrafficSource" (
    "date" DATE NOT NULL,
    "siteId" TEXT NOT NULL,
    "sourceSlug" TEXT NOT NULL,
    "pageLoads" INTEGER NOT NULL DEFAULT 0,
    "impsOwn" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "revenueReported" DECIMAL(12,4) NOT NULL DEFAULT 0,
    CONSTRAINT "FactTrafficSource_pkey" PRIMARY KEY ("date","siteId","sourceSlug")
);
CREATE INDEX "FactTrafficSource_date_idx" ON "FactTrafficSource"("date");
ALTER TABLE "FactTrafficSource" ADD CONSTRAINT "FactTrafficSource_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FactTrafficSource" ADD CONSTRAINT "FactTrafficSource_sourceSlug_fkey" FOREIGN KEY ("sourceSlug") REFERENCES "CostSource"("slug") ON DELETE RESTRICT ON UPDATE CASCADE;
