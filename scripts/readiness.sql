-- Readiness checklist from docs/tubestat-spec.md, run against the production database by
-- scripts/readiness.sh. The repository is public and the output lands in a CI log, so every
-- row is `check|value|PASS/FAIL/INFO` with counts, shares and statuses only: no domains,
-- no money, no error texts.
WITH
y AS (SELECT (now() AT TIME ZONE 'UTC')::date - 1 AS d),
w AS (SELECT (SELECT d FROM y) - 6 AS d_from, (SELECT d FROM y) AS d_to),
last_run AS (
  SELECT DISTINCT ON (source) source, status
  FROM "IngestRun"
  WHERE source IN ('adspyglass', 'metrika') AND "dateTo" >= (SELECT d FROM y) AND status <> 'running'
  ORDER BY source, "startedAt" DESC
),
geo AS (
  SELECT count(*) AS rows, count(*) FILTER (WHERE "countryCode" = 'XX') AS unknown
  FROM "FactRevenueGeo" WHERE date BETWEEN (SELECT d_from FROM w) AND (SELECT d_to FROM w)
),
recon AS (
  SELECT count(*) AS runs, count(*) FILTER (WHERE error LIKE '%сверка с итогом ADOK%') AS off
  FROM "IngestRun" WHERE source = 'adspyglass' AND "startedAt" > now() - interval '7 days' AND status <> 'running'
),
romi AS (
  SELECT count(*) FILTER (WHERE revenue > 0) AS with_rev, count(*) FILTER (WHERE revenue > 0 AND cost > 0) AS with_cost
  FROM v_site_geo_daily WHERE date BETWEEN (SELECT d_from FROM w) AND (SELECT d_to FROM w)
),
bundle_gap AS (
  SELECT count(*) AS bundles, count(*) FILTER (WHERE abs(b.revenue - s.revenue) > 0.01) AS mismatched
  FROM (SELECT bundle_id, COALESCE(SUM(revenue), 0) revenue FROM v_bundle_daily
        WHERE date BETWEEN (SELECT d_from FROM w) AND (SELECT d_to FROM w) GROUP BY 1) b
  JOIN LATERAL (SELECT COALESCE(SUM(g.revenue), 0) revenue FROM v_site_geo_daily g
        JOIN "BundleSite" bs ON bs."siteId" = g.site_id AND bs."bundleId" = b.bundle_id
        WHERE g.date BETWEEN (SELECT d_from FROM w) AND (SELECT d_to FROM w)) s ON true
),
deals AS (
  SELECT count(*) FILTER (WHERE d."billedVia" = 'DIRECT') AS direct, count(*) FILTER (WHERE d."billedVia" = 'VIA_ASG') AS via_asg
  FROM "Deal" d WHERE d.status IN ('ACTIVE', 'PAUSED')
),
sites AS (
  SELECT count(*) AS active, count("adsgSiteId") AS with_asg, count("metrikaId") AS with_metrika
  FROM "Site" WHERE status = 'ACTIVE'
),
fresh AS (
  SELECT (SELECT d FROM y) - (SELECT max(date) FROM "FactRevenueGeo") AS asg_lag,
         (SELECT d FROM y) - (SELECT max(date) FROM "FactTraffic") AS metrika_lag
)
SELECT c, v, verdict FROM (
  SELECT 1 o, 'ingest adspyglass yesterday' c, COALESCE((SELECT status FROM last_run WHERE source = 'adspyglass'), 'none') v,
         CASE WHEN (SELECT status FROM last_run WHERE source = 'adspyglass') = 'ok' THEN 'PASS' ELSE 'FAIL' END verdict
  UNION ALL SELECT 2, 'ingest metrika yesterday', COALESCE((SELECT status FROM last_run WHERE source = 'metrika'), 'none'),
         CASE WHEN (SELECT status FROM last_run WHERE source = 'metrika') = 'ok' THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 3, 'data lag days (asg / metrika)', COALESCE((SELECT asg_lag FROM fresh)::text, 'no data') || ' / ' || COALESCE((SELECT metrika_lag FROM fresh)::text, 'no data'),
         CASE WHEN (SELECT asg_lag FROM fresh) <= 0 AND (SELECT metrika_lag FROM fresh) <= 0 THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 4, 'unrecognised geo rows, 7d', CASE WHEN rows = 0 THEN 'no rows' ELSE round(unknown * 100.0 / rows, 2) || '%' END,
         CASE WHEN rows > 0 AND unknown * 100.0 / rows < 1 THEN 'PASS' ELSE 'FAIL' END FROM geo
  UNION ALL SELECT 5, 'asg runs off ADOK site total >2%, 7d', off || ' of ' || runs,
         CASE WHEN runs > 0 AND off = 0 THEN 'PASS' ELSE 'FAIL' END FROM recon
  UNION ALL SELECT 6, 'active deals direct / via asg', direct || ' / ' || via_asg, 'INFO' FROM deals
  UNION ALL SELECT 7, 'site-country-days with revenue that have cost, 7d',
         CASE WHEN with_rev = 0 THEN 'no revenue' ELSE round(with_cost * 100.0 / with_rev, 1) || '%' END,
         CASE WHEN with_cost > 0 THEN 'PASS' ELSE 'FAIL' END FROM romi
  UNION ALL SELECT 8, 'bundles whose total != sum of their sites, 7d', mismatched || ' of ' || bundles,
         CASE WHEN bundles > 0 AND mismatched = 0 THEN 'PASS' ELSE 'FAIL' END FROM bundle_gap
  UNION ALL SELECT 9, 'active sites / with asg id / with metrika id', active || ' / ' || with_asg || ' / ' || with_metrika,
         CASE WHEN active > 0 AND with_asg = active AND with_metrika = active THEN 'PASS' ELSE 'FAIL' END FROM sites
) t ORDER BY o;
