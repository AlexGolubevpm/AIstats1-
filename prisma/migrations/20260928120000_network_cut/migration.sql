-- CreateTable
CREATE TABLE "FactRevenueNetwork" (
    "date" DATE NOT NULL,
    "siteId" TEXT NOT NULL,
    "networkId" TEXT NOT NULL,
    "pageLoads" INTEGER NOT NULL DEFAULT 0,
    "impsOwn" INTEGER NOT NULL DEFAULT 0,
    "impsNetwork" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "revenueReported" DECIMAL(12,4) NOT NULL DEFAULT 0,

    CONSTRAINT "FactRevenueNetwork_pkey" PRIMARY KEY ("date","siteId","networkId")
);

-- CreateIndex
CREATE INDEX "FactRevenueNetwork_date_networkId_idx" ON "FactRevenueNetwork"("date", "networkId");

-- AddForeignKey
ALTER TABLE "FactRevenueNetwork" ADD CONSTRAINT "FactRevenueNetwork_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FactRevenueNetwork" ADD CONSTRAINT "FactRevenueNetwork_networkId_fkey" FOREIGN KEY ("networkId") REFERENCES "Network"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Network rows: the per-site network cut (FactRevenueNetwork, country ZZ) when a site-day has
-- one; otherwise the geo fact as before (demo data, and site-days ingested before this cut).
-- The account-wide "asg_all" geo rows of a site-day with a network cut are left out so the
-- same money is never shown twice.
CREATE OR REPLACE VIEW v_network_geo AS
WITH src AS (
  SELECT f.date, f."siteId", f."networkId", f."countryCode", f."pageLoads", f."impsOwn", f."impsNetwork", f."revenueReported"
  FROM "FactRevenueGeo" f
  WHERE NOT EXISTS (SELECT 1 FROM "FactRevenueNetwork" r WHERE r.date = f.date AND r."siteId" = f."siteId")
  UNION ALL
  SELECT r.date, r."siteId", r."networkId", 'ZZ', r."pageLoads", r."impsOwn", r."impsNetwork", r."revenueReported"
  FROM "FactRevenueNetwork" r
)
SELECT f.date, f."siteId" AS site_id, f."networkId" AS network_id, n.slug AS network_slug, n.title AS network_title,
       f."countryCode" AS country_code,
       SUM(f."pageLoads")::bigint AS page_loads, SUM(f."impsOwn")::bigint AS imps_own,
       SUM(f."impsNetwork")::bigint AS imps_network, SUM(f."revenueReported") AS revenue,
       CASE WHEN SUM(f."pageLoads") > 0 THEN SUM(f."impsOwn")::numeric / SUM(f."pageLoads") END AS fill_rate,
       CASE WHEN SUM(f."impsOwn") > 0 THEN (SUM(f."impsOwn") - SUM(f."impsNetwork"))::numeric / SUM(f."impsOwn") END AS discrepancy,
       CASE WHEN SUM(f."pageLoads") > 0 THEN SUM(f."revenueReported") / SUM(f."pageLoads") * 1000 END AS rev_per_1k_loads
FROM src f JOIN "Network" n ON n.id = f."networkId"
GROUP BY f.date, f."siteId", f."networkId", n.slug, n.title, f."countryCode";
