-- ADR 0016: fields ADOK sends that were dropped, the per-site format cut, and CTR in the views.
ALTER TABLE "FactRevenueGeo"     ADD COLUMN "requests" INTEGER, ADD COLUMN "brokerClicks" INTEGER, ADD COLUMN "fillRateAsg" DECIMAL(7,4), ADD COLUMN "predictedIncome" DECIMAL(12,4);
ALTER TABLE "FactRevenueNetwork" ADD COLUMN "requests" INTEGER, ADD COLUMN "brokerClicks" INTEGER, ADD COLUMN "fillRateAsg" DECIMAL(7,4), ADD COLUMN "predictedIncome" DECIMAL(12,4);
ALTER TABLE "FactRevenueDevice"  ADD COLUMN "requests" INTEGER, ADD COLUMN "brokerClicks" INTEGER, ADD COLUMN "fillRateAsg" DECIMAL(7,4), ADD COLUMN "predictedIncome" DECIMAL(12,4);
ALTER TABLE "FactRevenueZone"    ADD COLUMN "requests" INTEGER, ADD COLUMN "brokerClicks" INTEGER, ADD COLUMN "fillRateAsg" DECIMAL(7,4), ADD COLUMN "predictedIncome" DECIMAL(12,4);
ALTER TABLE "FactTrafficSource"  ADD COLUMN "impsNetwork" INTEGER, ADD COLUMN "requests" INTEGER, ADD COLUMN "brokerClicks" INTEGER, ADD COLUMN "fillRateAsg" DECIMAL(7,4), ADD COLUMN "predictedIncome" DECIMAL(12,4);

CREATE TABLE "FactRevenueFormat" (
  "date" DATE NOT NULL,
  "siteId" TEXT NOT NULL,
  "format" "AdFormat" NOT NULL,
  "requests" INTEGER,
  "pageLoads" INTEGER NOT NULL DEFAULT 0,
  "impsOwn" INTEGER NOT NULL DEFAULT 0,
  "impsNetwork" INTEGER NOT NULL DEFAULT 0,
  "clicks" INTEGER NOT NULL DEFAULT 0,
  "brokerClicks" INTEGER,
  "fillRateAsg" DECIMAL(7,4),
  "revenueReported" DECIMAL(12,4) NOT NULL DEFAULT 0,
  "predictedIncome" DECIMAL(12,4),
  CONSTRAINT "FactRevenueFormat_pkey" PRIMARY KEY ("date", "siteId", "format")
);
CREATE INDEX "FactRevenueFormat_date_idx" ON "FactRevenueFormat"("date");
ALTER TABLE "FactRevenueFormat" ADD CONSTRAINT "FactRevenueFormat_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- v_format_daily: the format cut when the site-day has one, the zones otherwise (demo data, days
-- before the cut). Viewable impressions exist only per zone, so views always come from the zones.
DROP VIEW IF EXISTS v_format_daily;
CREATE VIEW v_format_daily AS
WITH f AS (
  SELECT date, "siteId" AS site_id, format::text AS format, SUM(requests)::bigint AS requests,
         SUM("pageLoads")::bigint AS page_loads, SUM("impsOwn")::bigint AS imps_own, SUM("impsNetwork")::bigint AS imps_network,
         SUM(clicks)::bigint AS clicks, SUM("revenueReported") AS revenue,
         CASE WHEN SUM("pageLoads") > 0 THEN SUM("fillRateAsg" * "pageLoads") / SUM("pageLoads") END AS fill_rate_asg
  FROM "FactRevenueFormat" GROUP BY 1, 2, 3
), z AS (
  SELECT date, "siteId" AS site_id, format::text AS format,
         SUM("pageLoads")::bigint AS page_loads, SUM("impsOwn")::bigint AS imps_own, SUM("impsNetwork")::bigint AS imps_network,
         SUM(views)::bigint AS views, SUM(clicks)::bigint AS clicks, SUM("revenueReported") AS revenue
  FROM "FactRevenueZone" GROUP BY 1, 2, 3
), days AS (SELECT DISTINCT date, site_id FROM f)
SELECT COALESCE(f.date, z.date) AS date, COALESCE(f.site_id, z.site_id) AS site_id, COALESCE(f.format, z.format) AS format,
       f.requests,
       COALESCE(f.page_loads, z.page_loads) AS page_loads,
       COALESCE(f.imps_own, z.imps_own) AS imps_own,
       COALESCE(f.imps_network, z.imps_network) AS imps_network,
       COALESCE(z.views, 0)::bigint AS views,
       COALESCE(f.clicks, z.clicks) AS clicks,
       COALESCE(f.revenue, z.revenue) AS revenue,
       CASE WHEN COALESCE(f.imps_own, z.imps_own) > 0 THEN COALESCE(f.revenue, z.revenue) / COALESCE(f.imps_own, z.imps_own) * 1000 END AS cpm,
       f.fill_rate_asg,
       (f.date IS NOT NULL) AS from_format_cut
FROM f
FULL JOIN z ON z.date = f.date AND z.site_id = f.site_id AND z.format = f.format
-- a site-day with the format cut takes its rows only from the cut: a zone format missing there earned nothing that day
WHERE f.date IS NOT NULL OR NOT EXISTS (SELECT 1 FROM days d WHERE d.date = z.date AND d.site_id = z.site_id);

-- Clicks (CTR) in the zone and network views.
DROP VIEW IF EXISTS v_zone_daily;
CREATE VIEW v_zone_daily AS
SELECT f.date, f."siteId" AS site_id, f."zoneId" AS zone_id, z."adsgZoneId" AS adsg_zone_id, z.name AS zone_name,
       f.format::text AS format, z.position,
       f."pageLoads"::bigint AS page_loads, f."impsOwn"::bigint AS imps_own, f.views::bigint AS views, f.clicks::bigint AS clicks,
       f."revenueReported" AS revenue,
       CASE WHEN f."impsOwn" > 0 THEN f.views::numeric / f."impsOwn" END AS view_rate,
       CASE WHEN f."impsOwn" > 0 THEN f."revenueReported" / f."impsOwn" * 1000 END AS cpm,
       CASE WHEN f.views > 0 THEN f."revenueReported" / f.views * 1000 END AS viewable_cpm
FROM "FactRevenueZone" f JOIN "Zone" z ON z.id = f."zoneId";

CREATE OR REPLACE VIEW v_network_geo AS
WITH src AS (
  SELECT f.date, f."siteId", f."networkId", f."countryCode", f."pageLoads", f."impsOwn", f."impsNetwork", f."revenueReported", f.clicks
  FROM "FactRevenueGeo" f
  WHERE NOT EXISTS (SELECT 1 FROM "FactRevenueNetwork" r WHERE r.date = f.date AND r."siteId" = f."siteId")
  UNION ALL
  SELECT r.date, r."siteId", r."networkId", 'ZZ', r."pageLoads", r."impsOwn", r."impsNetwork", r."revenueReported", r.clicks
  FROM "FactRevenueNetwork" r
)
SELECT f.date, f."siteId" AS site_id, f."networkId" AS network_id, n.slug AS network_slug, n.title AS network_title,
       f."countryCode" AS country_code,
       SUM(f."pageLoads")::bigint AS page_loads, SUM(f."impsOwn")::bigint AS imps_own,
       SUM(f."impsNetwork")::bigint AS imps_network, SUM(f."revenueReported") AS revenue,
       CASE WHEN SUM(f."pageLoads") > 0 THEN SUM(f."impsOwn")::numeric / SUM(f."pageLoads") END AS fill_rate,
       CASE WHEN SUM(f."impsOwn") > 0 THEN (SUM(f."impsOwn") - SUM(f."impsNetwork"))::numeric / SUM(f."impsOwn") END AS discrepancy,
       CASE WHEN SUM(f."pageLoads") > 0 THEN SUM(f."revenueReported") / SUM(f."pageLoads") * 1000 END AS rev_per_1k_loads,
       SUM(f.clicks)::bigint AS clicks
FROM src f JOIN "Network" n ON n.id = f."networkId"
GROUP BY f.date, f."siteId", f."networkId", n.slug, n.title, f."countryCode";

GRANT SELECT ON v_format_daily, v_zone_daily, v_network_geo TO mcp_reader;
