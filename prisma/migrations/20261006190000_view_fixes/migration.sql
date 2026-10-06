-- 1. Fix-deal page loads are not new traffic: a deal counted on AdSpyglass copies the loads the
--    site already has, so adding them to page_loads doubled a site's loads and halved rev / 1000
--    loads. They move to their own column `deal_loads`; `page_loads` is AdSpyglass traffic only.
-- 2. v_bundle_daily leaves archived sites out, like every page total does.
CREATE OR REPLACE VIEW v_site_geo_daily AS
WITH u AS (
  SELECT date, "siteId", "countryCode",
         "pageLoads"::bigint AS page_loads, "impsOwn"::bigint AS imps_own, "impsNetwork"::bigint AS imps_network,
         "revenueReported" AS revenue_mediated, "revenueConfirmed" AS revenue_mediated_confirmed,
         NULL::numeric AS revenue_direct, NULL::numeric AS revenue_direct_confirmed,
         NULL::bigint AS uniques, NULL::bigint AS pageviews, NULL::bigint AS sessions,
         NULL::numeric AS cost, NULL::bigint AS uniques_bought, NULL::bigint AS deal_loads
  FROM "FactRevenueGeo"
  UNION ALL
  -- Only deals billed outside AdSpyglass: VIA_ASG money is already in own_deals.
  SELECT f.date, f."siteId", f."countryCode", NULL, NULL, NULL, NULL, NULL,
         f.revenue, CASE WHEN f."revenueState" = 'CONFIRMED' THEN f.revenue END, NULL, NULL, NULL, NULL, NULL, f."pageLoads"
  FROM "FactFixDeal" f JOIN "Deal" d ON d.id = f."dealId"
  WHERE d."billedVia" = 'DIRECT'
  UNION ALL
  SELECT date, "siteId", "countryCode", NULL, NULL, NULL, NULL, NULL, NULL, NULL, uniques, pageviews, sessions, NULL, NULL, NULL
  FROM "FactTraffic"
  UNION ALL
  SELECT date, "siteId", "countryCode", NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, cost, "uniquesBought", NULL
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
  COALESCE(SUM(deal_loads), 0)::bigint AS deal_loads
FROM u
GROUP BY date, "siteId", "countryCode";

CREATE OR REPLACE VIEW v_bundle_daily AS
SELECT g.date, bs."bundleId" AS bundle_id, b.slug AS bundle_slug,
       SUM(g.revenue) AS revenue, SUM(g.revenue_confirmed) AS revenue_confirmed,
       SUM(g.cost) AS cost, SUM(g.margin) AS margin,
       CASE WHEN SUM(g.cost) > 0 THEN SUM(g.margin) / SUM(g.cost) * 100 END AS romi,
       SUM(g.uniques)::bigint AS uniques, SUM(g.pageviews)::bigint AS pageviews,
       SUM(g.page_loads)::bigint AS page_loads,
       CASE WHEN SUM(g.uniques) > 0 THEN SUM(g.revenue) / SUM(g.uniques) * 1000 END AS rpm
FROM v_site_geo_daily g
JOIN "BundleSite" bs ON bs."siteId" = g.site_id
JOIN "Bundle" b ON b.id = bs."bundleId"
JOIN "Site" s ON s.id = g.site_id AND s.status <> 'ARCHIVED'
GROUP BY g.date, bs."bundleId", b.slug;
