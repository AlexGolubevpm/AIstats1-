-- Reporting views. All metrics are ratios of sums (never averages of ratios).
-- Direct revenue counts only deals billed outside AdSpyglass (BilledVia = DIRECT):
-- VIA_ASG deals are already inside mediated revenue as network own_deals.

CREATE VIEW v_sites AS
SELECT s.id AS site_id, s.domain, s.title, s.status::text AS status, s."adsgSiteId" AS adsg_site_id,
       s."metrikaId" AS metrika_id, s."launchedAt" AS launched_at,
       COALESCE(array_agg(b.slug ORDER BY b.slug) FILTER (WHERE b.slug IS NOT NULL), '{}') AS bundles
FROM "Site" s
LEFT JOIN "BundleSite" bs ON bs."siteId" = s.id
LEFT JOIN "Bundle" b ON b.id = bs."bundleId"
GROUP BY s.id;

CREATE VIEW v_bundles AS
SELECT b.id AS bundle_id, b.slug, b.title, b.color, count(bs."siteId")::int AS sites
FROM "Bundle" b LEFT JOIN "BundleSite" bs ON bs."bundleId" = b.id
GROUP BY b.id;

CREATE VIEW v_site_geo_daily AS
WITH rev AS (
  SELECT date, "siteId", "countryCode",
         SUM("pageLoads")::bigint AS page_loads,
         SUM("impsOwn")::bigint AS imps_own,
         SUM("impsNetwork")::bigint AS imps_network,
         SUM("revenueReported") AS revenue_mediated,
         SUM("revenueConfirmed") AS revenue_mediated_confirmed
  FROM "FactRevenueGeo" GROUP BY 1, 2, 3
),
deal AS (
  SELECT f.date, f."siteId", f."countryCode",
         SUM(f.revenue) AS revenue_direct,
         SUM(f.revenue) FILTER (WHERE f."revenueState" = 'CONFIRMED') AS revenue_direct_confirmed,
         SUM(f."pageLoads")::bigint AS deal_loads
  FROM "FactFixDeal" f JOIN "Deal" d ON d.id = f."dealId"
  WHERE d."billedVia" = 'DIRECT'
  GROUP BY 1, 2, 3
),
tr AS (
  SELECT date, "siteId", "countryCode",
         SUM(uniques)::bigint AS uniques, SUM(pageviews)::bigint AS pageviews, SUM(sessions)::bigint AS sessions
  FROM "FactTraffic" GROUP BY 1, 2, 3
),
cost AS (
  SELECT date, "siteId", "countryCode", SUM(cost) AS cost, SUM("uniquesBought")::bigint AS uniques_bought
  FROM "FactCost" GROUP BY 1, 2, 3
),
k AS (
  SELECT date, "siteId", "countryCode" FROM rev
  UNION SELECT date, "siteId", "countryCode" FROM deal
  UNION SELECT date, "siteId", "countryCode" FROM tr
  UNION SELECT date, "siteId", "countryCode" FROM cost
)
SELECT
  k.date,
  k."siteId" AS site_id,
  k."countryCode" AS country_code,
  COALESCE(rev.page_loads, 0) + COALESCE(deal.deal_loads, 0) AS page_loads,
  COALESCE(rev.imps_own, 0) AS imps_own,
  COALESCE(rev.imps_network, 0) AS imps_network,
  COALESCE(rev.revenue_mediated, 0) AS revenue_mediated,
  COALESCE(deal.revenue_direct, 0) AS revenue_direct,
  COALESCE(rev.revenue_mediated, 0) + COALESCE(deal.revenue_direct, 0) AS revenue,
  COALESCE(rev.revenue_mediated_confirmed, 0) + COALESCE(deal.revenue_direct_confirmed, 0) AS revenue_confirmed,
  COALESCE(tr.uniques, 0) AS uniques,
  COALESCE(tr.pageviews, 0) AS pageviews,
  COALESCE(tr.sessions, 0) AS sessions,
  COALESCE(cost.cost, 0) AS cost,
  COALESCE(cost.uniques_bought, 0) AS uniques_bought,
  COALESCE(rev.revenue_mediated, 0) + COALESCE(deal.revenue_direct, 0) - COALESCE(cost.cost, 0) AS margin
FROM k
LEFT JOIN rev  ON rev.date  = k.date AND rev."siteId"  = k."siteId" AND rev."countryCode"  = k."countryCode"
LEFT JOIN deal ON deal.date = k.date AND deal."siteId" = k."siteId" AND deal."countryCode" = k."countryCode"
LEFT JOIN tr   ON tr.date   = k.date AND tr."siteId"   = k."siteId" AND tr."countryCode"   = k."countryCode"
LEFT JOIN cost ON cost.date = k.date AND cost."siteId" = k."siteId" AND cost."countryCode" = k."countryCode";

CREATE VIEW v_bundle_daily AS
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
GROUP BY g.date, bs."bundleId", b.slug;

CREATE VIEW v_zone_daily AS
SELECT f.date, f."siteId" AS site_id, f."zoneId" AS zone_id, z."adsgZoneId" AS adsg_zone_id, z.name AS zone_name,
       f.format::text AS format, z.position,
       f."pageLoads"::bigint AS page_loads, f."impsOwn"::bigint AS imps_own, f.views::bigint AS views,
       f."revenueReported" AS revenue,
       CASE WHEN f."impsOwn" > 0 THEN f.views::numeric / f."impsOwn" END AS view_rate,
       CASE WHEN f."impsOwn" > 0 THEN f."revenueReported" / f."impsOwn" * 1000 END AS cpm,
       CASE WHEN f.views > 0 THEN f."revenueReported" / f.views * 1000 END AS viewable_cpm
FROM "FactRevenueZone" f JOIN "Zone" z ON z.id = f."zoneId";

CREATE VIEW v_network_geo AS
SELECT f.date, f."siteId" AS site_id, f."networkId" AS network_id, n.slug AS network_slug, n.title AS network_title,
       f."countryCode" AS country_code,
       SUM(f."pageLoads")::bigint AS page_loads, SUM(f."impsOwn")::bigint AS imps_own,
       SUM(f."impsNetwork")::bigint AS imps_network, SUM(f."revenueReported") AS revenue,
       CASE WHEN SUM(f."pageLoads") > 0 THEN SUM(f."impsOwn")::numeric / SUM(f."pageLoads") END AS fill_rate,
       CASE WHEN SUM(f."impsOwn") > 0 THEN (SUM(f."impsOwn") - SUM(f."impsNetwork"))::numeric / SUM(f."impsOwn") END AS discrepancy,
       CASE WHEN SUM(f."pageLoads") > 0 THEN SUM(f."revenueReported") / SUM(f."pageLoads") * 1000 END AS rev_per_1k_loads
FROM "FactRevenueGeo" f JOIN "Network" n ON n.id = f."networkId"
GROUP BY f.date, f."siteId", f."networkId", n.slug, n.title, f."countryCode";

CREATE VIEW v_format_daily AS
SELECT date, "siteId" AS site_id, format::text AS format,
       SUM("pageLoads")::bigint AS page_loads, SUM("impsOwn")::bigint AS imps_own,
       SUM(views)::bigint AS views, SUM("revenueReported") AS revenue,
       CASE WHEN SUM("impsOwn") > 0 THEN SUM("revenueReported") / SUM("impsOwn") * 1000 END AS cpm
FROM "FactRevenueZone" GROUP BY 1, 2, 3;

CREATE VIEW v_deal_daily AS
SELECT f.date, f."dealId" AS deal_id, d.title AS deal_title, a.name AS advertiser,
       d."billedVia"::text AS billed_via, d."paymentBasis"::text AS payment_basis,
       f."siteId" AS site_id, f."countryCode" AS country_code,
       f."pageLoads"::bigint AS page_loads, f."impsOwn"::bigint AS imps_own, f."impsReported"::bigint AS imps_reported,
       f.revenue, f."revenueState"::text AS revenue_state
FROM "FactFixDeal" f JOIN "Deal" d ON d.id = f."dealId" JOIN "Advertiser" a ON a.id = d."advertiserId";

CREATE VIEW v_alerts_active AS
SELECT id, rule, level::text AS level, title, message, link, "siteId" AS site_id, "moneyAtRisk" AS money_at_risk,
       "firstSeenAt" AS first_seen_at, "lastSeenAt" AS last_seen_at
FROM "Alert"
WHERE "resolvedAt" IS NULL AND ("snoozedUntil" IS NULL OR "snoozedUntil" < now());

-- Read-only role for the MCP `query` tool. NOLOGIN: the app switches to it with
-- SET LOCAL ROLE inside a read-only transaction, so no extra password is needed.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_reader') THEN
    CREATE ROLE mcp_reader NOLOGIN;
  END IF;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM mcp_reader;
GRANT USAGE ON SCHEMA public TO mcp_reader;
GRANT SELECT ON v_sites, v_bundles, v_site_geo_daily, v_bundle_daily, v_zone_daily, v_network_geo,
                v_format_daily, v_deal_daily, v_alerts_active TO mcp_reader;
GRANT mcp_reader TO CURRENT_USER;
