-- Readiness checklist from docs/tubestat-spec.md, run against the production database by
-- scripts/readiness.sh. The repository is public and the output lands in a CI log, so every
-- row is `check|value|PASS/FAIL/INFO` with counts, shares and statuses only: no domains,
-- no money, no error texts.
WITH
y AS (SELECT (now() AT TIME ZONE 'UTC')::date - 1 AS d),
w AS (SELECT (SELECT d FROM y) - 6 AS d_from, (SELECT d FROM y) AS d_to),
-- The nightly per-site cuts, not the hourly totals: a dead night must not hide behind a fresh hourly run.
last_run AS (
  SELECT DISTINCT ON (source) source, status
  FROM "IngestRun"
  WHERE source IN ('adspyglass', 'metrika') AND "dateTo" >= (SELECT d FROM y) AND status <> 'running' AND job <> 'asg:totals'
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
-- Cost coverage: free sources (Direct, organic) write no cost rows, so the check is "every active
-- site with AdSpyglass has its traffic-source cut for yesterday" — that is where cost comes from.
src_cov AS (
  SELECT count(*) AS active,
         count(*) FILTER (WHERE EXISTS (SELECT 1 FROM "FactTrafficSource" f WHERE f."siteId" = s.id AND f.date = (SELECT d FROM y))) AS with_sources
  FROM "Site" s WHERE s.status = 'ACTIVE' AND s."adsgSiteId" IS NOT NULL
),
-- The network cut (adnetwork_squashed per site) must add up to the site totals it was taken from: the gap
-- in % of mediated revenue over 7 days. Bundles overlap, so bundles are only informative.
net_vs_sites AS (
  SELECT (SELECT COALESCE(SUM(revenue_mediated), 0) FROM v_site_geo_daily WHERE date BETWEEN (SELECT d_from FROM w) AND (SELECT d_to FROM w)
            AND site_id IN (SELECT id FROM "Site" WHERE status <> 'ARCHIVED')) AS sites_rev,
         (SELECT COALESCE(SUM(revenue), 0) FROM v_network_geo WHERE date BETWEEN (SELECT d_from FROM w) AND (SELECT d_to FROM w)
            AND site_id IN (SELECT id FROM "Site" WHERE status <> 'ARCHIVED')) AS nets_rev,
         (SELECT count(*) FROM (SELECT "siteId" FROM "BundleSite" GROUP BY 1 HAVING count(*) > 1) x) AS overlapping
),
-- Days of the week that have AdSpyglass revenue but no traffic-source cut anywhere: their cost is 0 because it was never loaded.
cost_days AS (
  SELECT count(*) AS days, count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM "FactTrafficSource" f WHERE f.date = g.date)) AS without_cost
  FROM (SELECT DISTINCT date FROM "FactRevenueGeo" WHERE date BETWEEN (SELECT d_from FROM w) AND (SELECT d_to FROM w)) g
),
metrika_cfg AS (
  SELECT (count("metrikaId") > 0) AS configured FROM "Site" WHERE status = 'ACTIVE'
),
deals AS (
  SELECT count(*) FILTER (WHERE d."billedVia" = 'DIRECT') AS direct, count(*) FILTER (WHERE d."billedVia" = 'VIA_ASG') AS via_asg
  FROM "Deal" d WHERE d.status IN ('ACTIVE', 'PAUSED')
),
sites AS (
  SELECT count(*) AS active, count("adsgSiteId") AS with_asg, count("metrikaId") AS with_metrika
  FROM "Site" WHERE status = 'ACTIVE'
),
-- Lag counts only days with a per-site country cut: today's hourly ZZ totals always exist and would say "no lag".
fresh AS (
  SELECT (SELECT d FROM y) - (SELECT max(date) FROM "FactRevenueGeo" WHERE "countryCode" <> 'ZZ') AS asg_lag,
         (SELECT d FROM y) - (SELECT max(date) FROM "FactTraffic") AS metrika_lag
)
SELECT c, v, verdict FROM (
  -- partial = data landed with a reconciliation note (check 5 counts those); only failed/none is red
  SELECT 1 o, 'ingest adspyglass yesterday' c, COALESCE((SELECT status FROM last_run WHERE source = 'adspyglass'), 'none') v,
         CASE WHEN (SELECT status FROM last_run WHERE source = 'adspyglass') IN ('ok', 'partial') THEN 'PASS' ELSE 'FAIL' END verdict
  UNION ALL SELECT 2, 'ingest metrika yesterday', CASE WHEN NOT (SELECT configured FROM metrika_cfg) THEN 'not configured' ELSE COALESCE((SELECT status FROM last_run WHERE source = 'metrika'), 'none') END,
         CASE WHEN NOT (SELECT configured FROM metrika_cfg) THEN 'INFO' WHEN (SELECT status FROM last_run WHERE source = 'metrika') IN ('ok', 'partial') THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 3, 'data lag days (asg / metrika)', COALESCE((SELECT asg_lag FROM fresh)::text, 'no data') || ' / ' ||
         CASE WHEN NOT (SELECT configured FROM metrika_cfg) THEN 'n/a' ELSE COALESCE((SELECT metrika_lag FROM fresh)::text, 'no data') END,
         CASE WHEN (SELECT asg_lag FROM fresh) <= 0 AND (NOT (SELECT configured FROM metrika_cfg) OR (SELECT metrika_lag FROM fresh) <= 0) THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 4, 'unrecognised geo rows, 7d', CASE WHEN rows = 0 THEN 'no rows' ELSE round(unknown * 100.0 / rows, 2) || '%' END,
         CASE WHEN rows > 0 AND unknown * 100.0 / rows < 1 THEN 'PASS' ELSE 'FAIL' END FROM geo
  UNION ALL SELECT 5, 'asg runs off ADOK site total >2%, 7d', off || ' of ' || runs,
         CASE WHEN runs > 0 AND off = 0 THEN 'PASS' ELSE 'FAIL' END FROM recon
  UNION ALL SELECT 6, 'active deals direct / via asg', direct || ' / ' || via_asg, 'INFO' FROM deals
  UNION ALL SELECT 7, 'asg sites with traffic-source cut (cost base) yesterday', with_sources || ' of ' || active,
         CASE WHEN active > 0 AND with_sources = active THEN 'PASS' ELSE 'FAIL' END FROM src_cov
  UNION ALL SELECT 8, 'network cut vs site totals, 7d (gap %) / sites in several bundles',
         CASE WHEN sites_rev = 0 THEN 'no data' ELSE round(abs(nets_rev - sites_rev) * 100.0 / sites_rev, 2) || '%' END || ' / ' || overlapping,
         CASE WHEN sites_rev = 0 OR abs(nets_rev - sites_rev) * 100.0 / sites_rev < 2 THEN 'PASS' ELSE 'FAIL' END FROM net_vs_sites
  UNION ALL SELECT 9, 'active sites / with asg id / with metrika id', active || ' / ' || with_asg || ' / ' || with_metrika,
         CASE WHEN active = 0 OR with_asg < active THEN 'FAIL' WHEN with_metrika = 0 THEN 'INFO' WHEN with_metrika < active THEN 'FAIL' ELSE 'PASS' END FROM sites
  UNION ALL SELECT 10, 'days with revenue but no traffic-source cut (cost missing), 7d', without_cost || ' of ' || days,
         CASE WHEN days = 0 OR without_cost = 0 THEN 'PASS' ELSE 'FAIL' END FROM cost_days
) t ORDER BY o;
