-- Cost by country is an estimate, and the alert and the geo pages estimated it differently (ADR 0015).
-- 1. v_site_geo_daily splits cost by nature: cost_rate (bought per unique/load/click: RATE, IMPORT) and
--    cost_revshare (a share of the revenue the source's traffic earned: ASG).
-- 2. v_site_geo_alloc_daily is the one allocation everybody reads: per day and site, the no-country (ZZ)
--    rate cost moves to the day's countries by page loads, the ZZ revshare cost by the countries' revenue.
--    A day without a country cut keeps everything on ZZ. Rows that received a share carry estimated = true.
CREATE OR REPLACE VIEW v_site_geo_daily AS
WITH u AS (
  SELECT date, "siteId", "countryCode",
         "pageLoads"::bigint AS page_loads, "impsOwn"::bigint AS imps_own, "impsNetwork"::bigint AS imps_network,
         "revenueReported" AS revenue_mediated, "revenueConfirmed" AS revenue_mediated_confirmed,
         NULL::numeric AS revenue_direct, NULL::numeric AS revenue_direct_confirmed,
         NULL::bigint AS uniques, NULL::bigint AS pageviews, NULL::bigint AS sessions,
         NULL::numeric AS cost, NULL::bigint AS uniques_bought, NULL::bigint AS deal_loads,
         NULL::numeric AS cost_rate, NULL::numeric AS cost_revshare
  FROM "FactRevenueGeo"
  UNION ALL
  -- Only deals billed outside AdSpyglass: VIA_ASG money is already in own_deals.
  SELECT f.date, f."siteId", f."countryCode", NULL, NULL, NULL, NULL, NULL,
         f.revenue, CASE WHEN f."revenueState" = 'CONFIRMED' THEN f.revenue END, NULL, NULL, NULL, NULL, NULL, f."pageLoads", NULL, NULL
  FROM "FactFixDeal" f JOIN "Deal" d ON d.id = f."dealId"
  WHERE d."billedVia" = 'DIRECT'
  UNION ALL
  SELECT date, "siteId", "countryCode", NULL, NULL, NULL, NULL, NULL, NULL, NULL, uniques, pageviews, sessions, NULL, NULL, NULL, NULL, NULL
  FROM "FactTraffic"
  UNION ALL
  SELECT date, "siteId", "countryCode", NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, cost, "uniquesBought", NULL,
         CASE WHEN origin = 'ASG' THEN 0 ELSE cost END, CASE WHEN origin = 'ASG' THEN cost ELSE 0 END
  FROM "FactCost"
)
SELECT
  date,
  "siteId" AS site_id,
  "countryCode" AS country_code,
  COALESCE(SUM(page_loads), 0)::bigint AS page_loads,
  COALESCE(SUM(imps_own), 0)::bigint AS imps_own,
  COALESCE(SUM(imps_network), 0)::bigint AS imps_network,
  COALESCE(SUM(revenue_mediated), 0) AS revenue_mediated,
  COALESCE(SUM(revenue_direct), 0) AS revenue_direct,
  COALESCE(SUM(revenue_mediated), 0) + COALESCE(SUM(revenue_direct), 0) AS revenue,
  COALESCE(SUM(revenue_mediated_confirmed), 0) + COALESCE(SUM(revenue_direct_confirmed), 0) AS revenue_confirmed,
  COALESCE(SUM(uniques), 0)::bigint AS uniques,
  COALESCE(SUM(pageviews), 0)::bigint AS pageviews,
  COALESCE(SUM(sessions), 0)::bigint AS sessions,
  COALESCE(SUM(cost), 0) AS cost,
  COALESCE(SUM(uniques_bought), 0)::bigint AS uniques_bought,
  COALESCE(SUM(revenue_mediated), 0) + COALESCE(SUM(revenue_direct), 0) - COALESCE(SUM(cost), 0) AS margin,
  COALESCE(SUM(deal_loads), 0)::bigint AS deal_loads,
  COALESCE(SUM(cost_rate), 0) AS cost_rate,
  COALESCE(SUM(cost_revshare), 0) AS cost_revshare
FROM u
GROUP BY date, "siteId", "countryCode";

CREATE VIEW v_site_geo_alloc_daily AS
WITH g AS (SELECT * FROM v_site_geo_daily),
real AS (SELECT * FROM g WHERE country_code NOT IN ('ZZ', 'XX')),
zz AS (SELECT date, site_id, cost_rate AS zz_rate, cost_revshare AS zz_revshare FROM g WHERE country_code = 'ZZ'),
tot AS (SELECT date, site_id, SUM(page_loads) AS loads, SUM(revenue) AS rev, COUNT(*) AS n FROM real GROUP BY 1, 2),
alloc AS (
  SELECT r.*,
         -- bought traffic is loads; a share of revenue follows revenue; with nothing to weigh by, evenly
         COALESCE(z.zz_rate, 0) * CASE WHEN t.loads > 0 THEN r.page_loads::numeric / t.loads ELSE 1.0 / t.n END AS add_rate,
         COALESCE(z.zz_revshare, 0) * CASE WHEN t.rev > 0 THEN r.revenue / t.rev WHEN t.loads > 0 THEN r.page_loads::numeric / t.loads ELSE 1.0 / t.n END AS add_revshare
  FROM real r JOIN tot t USING (date, site_id) LEFT JOIN zz z USING (date, site_id)
)
SELECT date, site_id, country_code, page_loads, imps_own, imps_network, revenue_mediated, revenue_direct, revenue, revenue_confirmed,
       uniques, pageviews, sessions, uniques_bought, deal_loads,
       cost + add_rate + add_revshare AS cost,
       cost_rate + add_rate AS cost_rate,
       cost_revshare + add_revshare AS cost_revshare,
       cost AS cost_own,
       revenue - (cost + add_rate + add_revshare) AS margin,
       (add_rate + add_revshare) > 0 AS estimated
FROM alloc
UNION ALL
-- XX (unrecognised) rows as they are; the ZZ row keeps its revenue, loads and Metrika numbers (cost 0 once
-- the day has countries to carry it; everything when it has none).
SELECT g.date, g.site_id, g.country_code, g.page_loads, g.imps_own, g.imps_network, g.revenue_mediated, g.revenue_direct, g.revenue, g.revenue_confirmed,
       g.uniques, g.pageviews, g.sessions, g.uniques_bought, g.deal_loads,
       CASE WHEN t.site_id IS NULL OR g.country_code = 'XX' THEN g.cost ELSE 0 END AS cost,
       CASE WHEN t.site_id IS NULL OR g.country_code = 'XX' THEN g.cost_rate ELSE 0 END AS cost_rate,
       CASE WHEN t.site_id IS NULL OR g.country_code = 'XX' THEN g.cost_revshare ELSE 0 END AS cost_revshare,
       g.cost AS cost_own,
       g.revenue - CASE WHEN t.site_id IS NULL OR g.country_code = 'XX' THEN g.cost ELSE 0 END AS margin,
       false AS estimated
FROM g LEFT JOIN tot t USING (date, site_id)
WHERE g.country_code = 'XX'
   OR (g.country_code = 'ZZ' AND (t.site_id IS NULL OR g.revenue <> 0 OR g.page_loads > 0 OR g.uniques > 0 OR g.deal_loads > 0));

GRANT SELECT ON v_site_geo_alloc_daily TO mcp_reader;
