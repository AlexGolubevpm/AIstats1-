#!/usr/bin/env bash
# Readiness checklist (docs/tubestat-spec.md) against production. Runs on the server as
# `deploy` (invoked by .github/workflows/readiness.yml over SSH) next to scripts/readiness.sql.
# Output is `check|value|verdict` only — safe for a public CI log. Exit 1 if anything FAILs.
# Usage: readiness.sh [path/to/readiness.sql]   Env: TUBESTAT_DIR (default /opt/tubestat)
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
sql="${1:-$here/readiness.sql}"
cd "${TUBESTAT_DIR:-/opt/tubestat}" || { echo "no stack directory"; exit 1; }
# compose interpolates ${APP_IMAGE:?} even for exec/ps; outside deploy.sh take the deployed one.
export APP_IMAGE="${APP_IMAGE:-$(cat .current-image 2>/dev/null || echo unset)}"

psql_() { docker compose exec -T postgres psql -U tubestat -d tubestat -X -q -At -F '|' -v ON_ERROR_STOP=1 "$@"; }

out="$(psql_ < "$sql" 2>/dev/null)" || { echo "database|unreachable|FAIL"; exit 1; }

# The site page's heaviest query: 30-day totals of the busiest site, timed inside Postgres.
page_ms="$(psql_ -c "EXPLAIN (ANALYZE, FORMAT JSON) SELECT SUM(revenue) FROM v_site_geo_daily g
  WHERE g.date >= current_date - 30 AND g.site_id = (SELECT \"siteId\" FROM \"FactRevenueGeo\"
  GROUP BY 1 ORDER BY count(*) DESC LIMIT 1)" 2>/dev/null | grep -o '"Execution Time": [0-9.]*' | grep -o '[0-9.]*$')"
if [ -n "$page_ms" ]; then
  v=$(printf '%.0f' "$page_ms"); verdict=$([ "$v" -lt 300 ] && echo PASS || echo FAIL)
  out+=$'\n'"site page 30d totals query ms (budget 300 of 1000)|$v|$verdict"
else
  out+=$'\n'"site page 30d totals query ms|no data|FAIL"
fi

# Required keys in .env — names only, the values never leave the server.
missing=""
for k in POSTGRES_PASSWORD APP_PASSWORD ASG_AUTH_EMAIL ASG_AUTH_TOKEN METRIKA_TOKEN; do
  grep -Eq "^$k=.+" .env 2>/dev/null || missing+="${missing:+ }$k"
done
grep -Eq '^COMPOSE_PROFILES=.*worker' .env 2>/dev/null || missing+="${missing:+ }COMPOSE_PROFILES=worker"
out+=$'\n'"server .env: missing keys|${missing:-none}|$([ -z "$missing" ] && echo PASS || echo FAIL)"

# Worker (COMPOSE_PROFILES=worker) and the daily backup cron.
if docker compose ps --status running worker 2>/dev/null | grep -q worker; then w=running; else w=stopped; fi
out+=$'\n'"worker container|$w|$([ "$w" = running ] && echo PASS || echo FAIL)"
newest="$(ls -1t backups/daily-*.dump 2>/dev/null | head -n1)"
if [ -n "$newest" ]; then
  age=$(( ($(date +%s) - $(stat -c %Y "$newest")) / 3600 )); n=$(ls -1 backups/daily-*.dump | wc -l)
  out+=$'\n'"daily backups: count / newest age h|$n / $age|$([ "$age" -le 26 ] && echo PASS || echo FAIL)"
else
  out+=$'\n'"daily backups|none yet (first at 03:30 UTC)|INFO"
fi

printf '%s\n' "$out" | awk -F'|' 'NF { printf "%-52s %-28s %s\n", $1, $2, $3 }'
! printf '%s\n' "$out" | grep -q '|FAIL$'
