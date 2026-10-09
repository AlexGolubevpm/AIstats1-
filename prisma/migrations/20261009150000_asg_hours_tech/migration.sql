-- ADR 0016: per-site hour, platform and browser cuts.
CREATE TYPE "TechKind" AS ENUM ('PLATFORM', 'BROWSER');

CREATE TABLE "FactRevenueHour" (
  "date" DATE NOT NULL, "siteId" TEXT NOT NULL, "hour" INTEGER NOT NULL,
  "requests" INTEGER, "pageLoads" INTEGER NOT NULL DEFAULT 0, "impsOwn" INTEGER NOT NULL DEFAULT 0, "impsNetwork" INTEGER NOT NULL DEFAULT 0,
  "clicks" INTEGER NOT NULL DEFAULT 0, "brokerClicks" INTEGER, "fillRateAsg" DECIMAL(7,4), "revenueReported" DECIMAL(12,4) NOT NULL DEFAULT 0, "predictedIncome" DECIMAL(12,4),
  CONSTRAINT "FactRevenueHour_pkey" PRIMARY KEY ("date", "siteId", "hour")
);
CREATE INDEX "FactRevenueHour_date_idx" ON "FactRevenueHour"("date");
ALTER TABLE "FactRevenueHour" ADD CONSTRAINT "FactRevenueHour_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "FactRevenueTech" (
  "date" DATE NOT NULL, "siteId" TEXT NOT NULL, "kind" "TechKind" NOT NULL, "name" TEXT NOT NULL,
  "requests" INTEGER, "pageLoads" INTEGER NOT NULL DEFAULT 0, "impsOwn" INTEGER NOT NULL DEFAULT 0, "impsNetwork" INTEGER NOT NULL DEFAULT 0,
  "clicks" INTEGER NOT NULL DEFAULT 0, "brokerClicks" INTEGER, "fillRateAsg" DECIMAL(7,4), "revenueReported" DECIMAL(12,4) NOT NULL DEFAULT 0, "predictedIncome" DECIMAL(12,4),
  CONSTRAINT "FactRevenueTech_pkey" PRIMARY KEY ("date", "siteId", "kind", "name")
);
CREATE INDEX "FactRevenueTech_date_idx" ON "FactRevenueTech"("date");
ALTER TABLE "FactRevenueTech" ADD CONSTRAINT "FactRevenueTech_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
