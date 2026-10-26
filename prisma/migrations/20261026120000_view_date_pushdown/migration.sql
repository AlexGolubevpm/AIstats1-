-- Date filters reach the fact tables again (ADR 0015, 0016 addenda). Both views referenced a CTE more than
-- once, so Postgres materialised it over the whole history on every query and filtered afterwards: /geo
-- (three such queries per request) slowed down with every day loaded and timed out. Same columns, same
-- types, same rows (checked with EXCEPT both ways); CREATE OR REPLACE keeps the mcp_reader grants.

-- Geo with the no-country cost spread over the countries: one pass with window sums per (date, site_id)
-- instead of joining the view to aggregates of itself. A filter on date sits on the partition key and is
-- pushed below the window into the fact tables.
CREATE OR REPLACE VIEW v_site_geo_alloc_daily AS
SELECT date, site_id, country_code, page_loads, imps_own, imps_network, revenue_mediated, revenue_direct, revenue, revenue_confirmed,
       uniques, pageviews, sessions, uniques_bought, deal_loads,
       CASE WHEN is_real THEN cost + add_rate + add_revshare WHEN t_n = 0 OR country_code = 'XX' THEN cost ELSE 0 END AS cost,
       CASE WHEN is_real THEN cost_rate + add_rate WHEN t_n = 0 OR country_code = 'XX' THEN cost_rate ELSE 0 END AS cost_rate,
       CASE WHEN is_real THEN cost_revshare + add_revshare WHEN t_n = 0 OR country_code = 'XX' THEN cost_revshare ELSE 0 END AS cost_revshare,
       cost AS cost_own,
       revenue - CASE WHEN is_real THEN cost + add_rate + add_revshare WHEN t_n = 0 OR country_code = 'XX' THEN cost ELSE 0 END AS margin,
       is_real AND (add_rate + add_revshare) > 0 AS estimated
FROM (
  SELECT w.*,
         CASE WHEN is_real THEN COALESCE(zz_rate, 0) * CASE WHEN t_loads > 0 THEN page_loads::numeric / t_loads ELSE 1.0 / t_n END END AS add_rate,
         CASE WHEN is_real THEN COALESCE(zz_revshare, 0) * CASE WHEN t_rev > 0 THEN revenue / t_rev WHEN t_loads > 0 THEN page_loads::numeric / t_loads ELSE 1.0 / t_n END END AS add_revshare
  FROM (
    SELECT g.*,
           SUM(page_loads) FILTER (WHERE is_real) OVER p AS t_loads,
           SUM(revenue) FILTER (WHERE is_real) OVER p AS t_rev,
           COUNT(*) FILTER (WHERE is_real) OVER p AS t_n,
           MAX(cost_rate) FILTER (WHERE country_code = 'ZZ') OVER p AS zz_rate,
           MAX(cost_revshare) FILTER (WHERE country_code = 'ZZ') OVER p AS zz_revshare
    FROM (SELECT d.*, d.country_code NOT IN ('ZZ', 'XX') AS is_real FROM v_site_geo_daily d) g
    WINDOW p AS (PARTITION BY date, site_id)
  ) w
) a
WHERE is_real OR country_code = 'XX'
   OR (country_code = 'ZZ' AND (t_n = 0 OR revenue <> 0 OR page_loads > 0 OR uniques > 0 OR deal_loads > 0));

-- Formats: the ad_type cut where it exists (views from the zones of the same site, day and format),
-- else the zones of a day that has no ad_type cut for the site. A UNION ALL of two grouped scans instead of
-- a FULL JOIN of CTEs filtered by COALESCE(f.date, z.date).
CREATE OR REPLACE VIEW v_format_daily AS
SELECT f.date, f."siteId" AS site_id, f.format::text AS format,
       SUM(f.requests) AS requests, SUM(f."pageLoads") AS page_loads, SUM(f."impsOwn") AS imps_own, SUM(f."impsNetwork") AS imps_network,
       COALESCE((SELECT SUM(z.views) FROM "FactRevenueZone" z WHERE z.date = f.date AND z."siteId" = f."siteId" AND z.format = f.format), 0::bigint) AS views,
       SUM(f.clicks) AS clicks, SUM(f."revenueReported") AS revenue,
       CASE WHEN SUM(f."impsOwn") > 0 THEN SUM(f."revenueReported") / SUM(f."impsOwn")::numeric * 1000::numeric END AS cpm,
       CASE WHEN SUM(f."pageLoads") > 0 THEN SUM(f."fillRateAsg" * f."pageLoads"::numeric) / SUM(f."pageLoads")::numeric END AS fill_rate_asg,
       true AS from_format_cut
FROM "FactRevenueFormat" f
GROUP BY f.date, f."siteId", f.format
UNION ALL
SELECT z.date, z."siteId", z.format::text, NULL::bigint, SUM(z."pageLoads"), SUM(z."impsOwn"), SUM(z."impsNetwork"), COALESCE(SUM(z.views), 0::bigint),
       SUM(z.clicks), SUM(z."revenueReported"),
       CASE WHEN SUM(z."impsOwn") > 0 THEN SUM(z."revenueReported") / SUM(z."impsOwn")::numeric * 1000::numeric END,
       NULL::numeric, false
FROM "FactRevenueZone" z
WHERE NOT EXISTS (SELECT 1 FROM "FactRevenueFormat" f WHERE f.date = z.date AND f."siteId" = z."siteId")
GROUP BY z.date, z."siteId", z.format;
