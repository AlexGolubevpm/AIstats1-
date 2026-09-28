-- v_site_geo_daily, same columns and meaning, rewritten as one UNION ALL + GROUP BY.
-- The old form referenced each source CTE twice (key list + join), so Postgres
-- materialised them: a site/date filter never reached the fact tables and the joins
-- became nested loops over CTE scans (~0.7 s per site-page query on demo data).
-- Here a filter on date / site_id / country_code is pushed into every branch.
CREATE OR REPLACE VIEW v_site_geo_daily AS
WITH u AS (
  SELECT date, "siteId", "countryCode",
         "pageLoads"::bigint AS page_loads, "impsOwn"::bigint AS imps_own, "impsNetwork"::bigint AS imps_network,
         "revenueReported" AS revenue_mediated, "revenueConfirmed" AS revenue_mediated_confirmed,
         NULL::numeric AS revenue_direct, NULL::numeric AS revenue_direct_confirmed,
         NULL::bigint AS uniques, NULL::bigint AS pageviews, NULL::bigint AS sessions,
         NULL::numeric AS cost, NULL::bigint AS uniques_bought
  FROM "FactRevenueGeo"
  UNION ALL
  -- Only deals billed outside AdSpyglass: VIA_ASG money is already in own_deals.
  SELECT f.date, f."siteId", f."countryCode", f."pageLoads", NULL, NULL, NULL, NULL,
         f.revenue, CASE WHEN f."revenueState" = 'CONFIRMED' THEN f.revenue END, NULL, NULL, NULL, NULL, NULL
  FROM "FactFixDeal" f JOIN "Deal" d ON d.id = f."dealId"
  WHERE d."billedVia" = 'DIRECT'
  UNION ALL
  SELECT date, "siteId", "countryCode", NULL, NULL, NULL, NULL, NULL, NULL, NULL, uniques, pageviews, sessions, NULL, NULL
  FROM "FactTraffic"
  UNION ALL
  SELECT date, "siteId", "countryCode", NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, cost, "uniquesBought"
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
  COALESCE(SUM(revenue_mediated), 0) + COALESCE(SUM(revenue_direct), 0) - COALESCE(SUM(cost), 0) AS margin
FROM u
GROUP BY date, "siteId", "countryCode";
