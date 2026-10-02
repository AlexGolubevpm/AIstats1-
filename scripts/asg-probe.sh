#!/usr/bin/env bash
# Probe the AdSpyGlass (adok.ai) report API to find which groupings it supports.
# Usage: ASG_AUTH_EMAIL=... ASG_AUTH_TOKEN=... ./scripts/asg-probe.sh [YYYY-MM-DD] [website_id]
# Saves every response to docs/asg-samples/ (or $ASG_PROBE_OUT) and prints a status summary.
# ASG_PROBE_REDACT=1 prints only structure (status, row counts, field names, masked name
# shapes) — required when output goes to public CI logs.
# ADOK blocks clients that send many requests: requests are spaced by ASG_PROBE_DELAY seconds
# (default 5), capped at ASG_PROBE_MAX_REQUESTS (default 12), and the run stops at the first
# auth failure / rate limit instead of hammering the API.
set -uo pipefail

BASE="${ASG_API_URL:-https://api.adok.ai/api}"
DATE="${1:-$(date -u -d yesterday +%F 2>/dev/null || date -u -v-1d +%F)}"
SITE="${2:-}"
OUT="${ASG_PROBE_OUT:-$(dirname "$0")/../docs/asg-samples}"
REDACT="${ASG_PROBE_REDACT:-0}"
SHAPE="$(dirname "$0")/ci/shape.sh"
DELAY="${ASG_PROBE_DELAY:-5}"
MAX_REQUESTS="${ASG_PROBE_MAX_REQUESTS:-12}"
# ADOK has no partner/network grouping (every name answers 422), so the search can be skipped.
SKIP_PARTNER="${ASG_PROBE_SKIP_PARTNER:-0}"
REQUESTS=0
LAST_CODE=""
LAST_ROWS=""
mkdir -p "$OUT"

: "${ASG_AUTH_EMAIL:?set ASG_AUTH_EMAIL}"
: "${ASG_AUTH_TOKEN:?set ASG_AUTH_TOKEN}"

# Secrets pasted into web forms often carry a trailing newline or spaces, which the API
# rejects (it answers 302 to a login page). Report it without revealing the values, then strip.
describe_secret() {
  local name="$1" value="$2" ws="no"
  [[ "$value" =~ [[:space:]] ]] && ws="yes"
  printf '%s: length=%s whitespace=%s\n' "$name" "${#value}" "$ws"
}
describe_secret ASG_AUTH_EMAIL "$ASG_AUTH_EMAIL"
describe_secret ASG_AUTH_TOKEN "$ASG_AUTH_TOKEN"
ASG_AUTH_EMAIL=$(printf '%s' "$ASG_AUTH_EMAIL" | tr -d '[:space:]')
ASG_AUTH_TOKEN=$(printf '%s' "$ASG_AUTH_TOKEN" | tr -d '[:space:]')
# Character classes only (no values): catches a label like "API access token:" pasted in.
token_classes=$(printf '%s' "$ASG_AUTH_TOKEN" | tr -d '[:alnum:]' | wc -c | tr -d ' ')
printf 'after strip: ASG_AUTH_EMAIL length=%s, ASG_AUTH_TOKEN length=%s non-alphanumeric=%s\n' \
  "${#ASG_AUTH_EMAIL}" "${#ASG_AUTH_TOKEN}" "$token_classes"
# First 8 hex of sha256: lets the owner confirm the secret matches what they were given,
# without the log being usable to recover it.
fingerprint() { printf '%s' "$1" | sha256sum | cut -c1-8; }
printf 'fingerprints: email=%s token=%s\n' "$(fingerprint "$ASG_AUTH_EMAIL")" "$(fingerprint "$ASG_AUTH_TOKEN")"

# Stops the whole run: further requests would only deepen a block on the ADOK side.
stop_run() {
  echo
  echo "STOPPED after $REQUESTS request(s): $1"
  echo "Wait before the next run (ADOK throttles/blocks frequent requests)."
  exit 3
}

probe() {
  local label="$1" query="$2"
  local file="$OUT/${label}.json"
  local code redirect meta
  if [ "$REQUESTS" -ge "$MAX_REQUESTS" ]; then
    echo "$(printf '%-28s' "$label") skipped (request cap $MAX_REQUESTS reached)"
    LAST_CODE="skipped"
    return
  fi
  [ "$REQUESTS" -gt 0 ] && sleep "$DELAY"
  REQUESTS=$((REQUESTS + 1))
  local url="$BASE/report?from=${FROM:-$DATE}&to=$DATE&$query"
  [ -n "${NO_RANGE:-}" ] && url="$BASE/report?$query"
  meta=$(curl -gsS -m 60 -o "$file" -w '%{http_code} %{redirect_url}' \
    -H "X-Asg-Auth-Email: $ASG_AUTH_EMAIL" \
    -H "X-Asg-Auth-Token: $ASG_AUTH_TOKEN" \
    "$url" 2>"$OUT/.curl-error")
  # curl errors echo the URL (with site ids); in redacted mode keep only the curl error code.
  if [ -s "$OUT/.curl-error" ]; then
    if [ "$REDACT" = "1" ]; then sed -n 's/^curl: (\([0-9]*\)).*/curl error \1/p' "$OUT/.curl-error" | head -n1 >&2; else cat "$OUT/.curl-error" >&2; fi
  fi
  code=${meta%% *}
  redirect=${meta#* }
  [ "$redirect" = "$meta" ] && redirect=""
  local rows first
  rows=$(jq 'if type=="array" then length else "not-array" end' "$file" 2>/dev/null) || rows="not-json"
  [ -n "$rows" ] || rows="empty"
  if [ "$REDACT" = "1" ]; then
    if [ -n "$redirect" ]; then
      # Redirect target without query string: tells login page from path change.
      first="redirect -> ${redirect%%\?*}"
    elif [ "$code" != "200" ]; then
      # Error bodies carry the API's explanation, not report data.
      first=$(head -c 300 "$file" | tr '\n' ' ')
    elif [ "$rows" = "not-array" ]; then
      first="object keys: $(jq -r 'keys | join(",")' "$file" 2>/dev/null | cut -c1-120)"
    else
      first=$(jq -r '.[0].name // "" | tostring' "$file" 2>/dev/null | bash "$SHAPE")
    fi
  else
    first=$(jq -c 'if type=="array" then .[0].name else . end' "$file" 2>/dev/null | cut -c1-80)
    [ -n "$redirect" ] && first="redirect -> $redirect $first"
  fi
  printf '%-28s %s rows=%-6s first=%s\n' "$label" "$code" "$rows" "$first"
  LAST_CODE="$code"
  LAST_ROWS="$rows"
  case "$code" in
    302|401|403) stop_run "API rejected the credentials (HTTP $code${redirect:+, redirect to ${redirect%%\?*}})" ;;
    429) stop_run "rate limited (HTTP 429)" ;;
    000) stop_run "connection failed or reset by the API" ;;
  esac
}

site_q=""
[ -n "$SITE" ] && site_q="&website_id=$SITE"

echo "Date: $DATE  Site: ${SITE:-all}  delay=${DELAY}s  max_requests=$MAX_REQUESTS"
# 1. Known-good baseline. If this fails, nothing else will work — stop_run() ends here.
probe baseline_website "group_by=website"

# Site for per-site cuts: the given one, else the busiest site of the baseline (never printed).
CUT_SITE="$SITE"
if [ -z "$CUT_SITE" ] && [ -s "$OUT/baseline_website.json" ]; then
  CUT_SITE=$(jq -r 'if type=="array" and length>0 then (max_by(.hits // 0) | .name // "" | tostring | split(".")[0]) else "" end' \
    "$OUT/baseline_website.json" 2>/dev/null | grep -E '^[0-9]+$' || true)
fi
cut_q=""
[ -n "$CUT_SITE" ] && cut_q="&website_id=$CUT_SITE"

# Does a per-site filter really filter? Compares summed hits of a response with the site's
# own hits from the baseline and prints only the ratio (1.00 = filtered, >1 = ignored).
site_hits() {
  jq -r --arg id "$CUT_SITE" '[.[] | select((.name // "" | tostring | split(".")[0]) == $id) | (.hits // 0)] | add // 0' \
    "$OUT/baseline_website.json" 2>/dev/null || echo 0
}
filter_ratio() {
  local label="$1" total own
  own=$(site_hits)
  total=$(jq -r 'if type=="array" then ([.[] | (.hits // 0)] | add // 0) else 0 end' "$OUT/${label}.json" 2>/dev/null || echo 0)
  if [ "${own:-0}" = "0" ] || [ "$LAST_CODE" != "200" ]; then
    echo "   filter check $label: n/a"
  else
    echo "   filter check $label: hits = $(awk -v t="$total" -v o="$own" 'BEGIN { printf "%.2f", t / o }')x site total"
  fi
}

if [ "${ASG_PROBE_MODE:-}" = "traffic" ]; then
  # group_by=traffic_source: is its income the site revenue split by source, or something else
  # (spend)? Compares sums with the website cut, account-wide and for the busiest site.
  # Ratios, counts and field names only.
  ratios() { # $1 = file, $2 = reference jq filter over the website baseline
    jq -r --slurpfile w "$OUT/baseline_website.json" "( $2 ) as \$ref | [\"broker_income\",\"predicted_income\",\"hits\"][] as \$k |
      \"   \(\$k): sources/\(\"$3\") = \(([.[] | (.[\$k] // 0)] | add) / ((\$ref | map(.[\$k] // 0) | add) // 1) * 1000 | round / 1000)\"" "$1"; }
  probe ts_all "group_by=traffic_source"
  [ "$LAST_CODE" = "200" ] && ratios "$OUT/ts_all.json" '$w[0]' account
  echo "   fields: $(jq -r '.[0] | keys | join(",")' "$OUT/ts_all.json" 2>/dev/null | cut -c1-400)"
  echo "   numeric non-zero per source (masked names): "
  jq -r '.[] | "\(.name // "" | tostring)\t\((.hits // 0) > 0)\t\((.broker_income // 0) > 0)\t\((.predicted_income // 0) > 0)"' "$OUT/ts_all.json" 2>/dev/null \
    | while IFS=$'\t' read -r n h b p; do echo "     $(printf '%s' "$n" | bash "$SHAPE") hits>0=$h broker>0=$b predicted>0=$p"; done
  if [ -n "$CUT_SITE" ]; then
    probe ts_site "group_by=traffic_source&platforms_ids[]=$CUT_SITE"
    [ "$LAST_CODE" = "200" ] && ratios "$OUT/ts_site.json" "\$w[0] | map(select((.name // \"\" | tostring | split(\".\")[0]) == \"$CUT_SITE\"))" busiest-site
  fi
  echo; echo "Requests sent: $REQUESTS."
  exit 0
fi

if [ "${ASG_PROBE_MODE:-}" = "recon" ]; then
  # Where does TubeStat's revenue for $DATE differ from the API? Uses the stored raw responses,
  # so the only API request is the baseline above. Per-site lines carry ratios only, no names.
  [ -f /opt/tubestat/.current-image ] || stop_run "recon runs on the server only"
  OUT=$(cd "$OUT" && pwd); cd /opt/tubestat; export APP_IMAGE; APP_IMAGE=$(cat .current-image)
  psql_() { docker compose exec -T postgres psql -U tubestat -d tubestat -X -At -F ' ' -c "$1"; }
  values=$(jq -r '[.[] | "(\(.name // "" | tostring | split(".")[0] | tonumber? // 0), \(.broker_income // 0), \(.hits // 0))"] | join(",")' "$OUT/baseline_website.json")
  # The cabinet's network report is account-level: compare its totals with the website cut.
  probe acct_net "group_by=adnetwork_squashed"
  jq -r --slurpfile w "$OUT/baseline_website.json" '([$w[0][] | (.broker_income // 0)] | add) as $b |
    "   account network cut / website cut: broker_income=\(([.[] | (.broker_income // 0)] | add) / $b * 1000 | round / 1000) predicted_income=\(([.[] | (.predicted_income // 0)] | add) / $b * 1000 | round / 1000) (website predicted/broker=\(([$w[0][] | (.predicted_income // 0)] | add) / $b * 1000 | round / 1000))"' \
    "$OUT/acct_net.json" 2>/dev/null || echo "   account network cut: n/a"
  echo "== Per site, $DATE: db revenue / api revenue, db loads / api loads, db rows (sorted)"
  psql_ "WITH api(adsg, rev, hits) AS (VALUES $values),
    db AS (SELECT s.\"adsgSiteId\" adsg, SUM(f.\"revenueReported\") rev, SUM(f.\"pageLoads\") hits, count(*) n,
             count(*) FILTER (WHERE f.\"countryCode\" = 'ZZ') zz
           FROM \"FactRevenueGeo\" f JOIN \"Site\" s ON s.id = f.\"siteId\" WHERE f.date = DATE '$DATE' GROUP BY 1)
    SELECT COALESCE(round(db.rev / NULLIF(api.rev, 0), 3)::text, 'n/a'), COALESCE(round(db.hits::numeric / NULLIF(api.hits, 0), 3)::text, 'n/a'),
           COALESCE(db.n, 0), COALESCE(db.zz, 0), CASE WHEN api.adsg IS NULL THEN 'not-in-api' WHEN db.adsg IS NULL THEN 'not-in-db' ELSE '' END
    FROM api FULL JOIN db ON db.adsg = api.adsg ORDER BY 1" | awk '{ printf "   rev=%s loads=%s rows=%s zz=%s %s\n", $1, $2, $3, $4, $5 }'
  echo "== Ingest runs, last 2 days (no error texts)"
  psql_ "SELECT job, \"dateFrom\", \"dateTo\", status, \"rowsUpsert\", requests, to_char(\"startedAt\", 'MM-DD HH24:MI'),
           COALESCE(to_char(\"finishedAt\", 'HH24:MI'), '-'), (error IS NOT NULL), COALESCE(array_length(regexp_split_to_array(error, 'сверка'), 1) - 1, 0)
         FROM \"IngestRun\" WHERE \"startedAt\" > now() - interval '2 days' ORDER BY \"startedAt\" DESC LIMIT 30" \
    | awk '{ printf "   %-11s %s..%s %-8s rows=%s req=%s %s-%s err=%s recon_fails=%s\n", $1, $2, $3, $4, $5, $6, $7, $8, $9, $10 }'
  echo "== Stored raw country responses for $DATE vs the api site total (ratios, sorted)"
  docker compose exec -T -e API_JSON="$(cat "$OUT/baseline_website.json")" -e DAY="$DATE" web node -e '
    const fs = require("fs"), path = require("path");
    const api = new Map(JSON.parse(process.env.API_JSON).map((r) => [String(r.name).split(".")[0], r]));
    const root = "/data/raw/raw/adspyglass/country"; const out = [];
    for (const id of fs.existsSync(root) ? fs.readdirSync(root) : []) {
      const dir = path.join(root, id, process.env.DAY); if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir).sort(); const rows = JSON.parse(fs.readFileSync(path.join(dir, files.at(-1)), "utf8"));
      const sum = (k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0); const a = api.get(id);
      const named = rows.filter((r) => /total|итог|all/i.test(String(r.name)) || r.iso == null || r.iso === "").length;
      const isos = new Set(rows.map((r) => r.iso)).size;
      out.push([a ? (sum("broker_income") / (a.broker_income || NaN)).toFixed(3) : "n/a", a ? (sum("hits") / (a.hits || NaN)).toFixed(3) : "n/a", files.length, rows.length, isos, named]);
    }
    out.sort((x, y) => String(x[0]).localeCompare(String(y[0])));
    for (const o of out) console.log(`   rev=${o[0]} loads=${o[1]} files=${o[2]} rows=${o[3]} distinct_iso=${o[4]} total_or_no_iso_rows=${o[5]}`);
    if (!out.length) console.log("   no raw country files for this day");
    // Every numeric field of every stored cut, summed per site, as a ratio of the website cut
    // broker_income (median and max over sites) — shows which field the per-site cuts inflate.
    const base = "/data/raw/raw/adspyglass";
    const latest = (cut, id) => { const dir = path.join(base, cut, id, process.env.DAY); if (!fs.existsSync(dir)) return null;
      return JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir).sort().at(-1)), "utf8")); };
    const wsDir = path.join(base, "website", process.env.DAY);
    const ws = fs.existsSync(wsDir) ? JSON.parse(fs.readFileSync(path.join(wsDir, fs.readdirSync(wsDir).sort().at(-1)), "utf8")) : [];
    console.log(`== Stored website cut: rows=${ws.length} fields=${ws[0] ? Object.keys(ws[0]).join(",") : "-"}`);
    const med = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)].toFixed(3) : "-"; };
    // Zones: one account-level spot cut, "id. Name (domain)" — summed per domain vs the site total.
    const spotDir = path.join(base, "spot", process.env.DAY);
    if (fs.existsSync(spotDir)) {
      const spots = JSON.parse(fs.readFileSync(path.join(spotDir, fs.readdirSync(spotDir).sort().at(-1)), "utf8"));
      const byDomain = new Map();
      for (const r of spots) { const d = /\(([^()]+)\)\s*$/.exec(String(r.name))?.[1]?.trim().toLowerCase(); if (!d) continue;
        const cur = byDomain.get(d) ?? { b: 0, p: 0, h: 0 }; cur.b += Number(r.broker_income) || 0; cur.p += Number(r.predicted_income) || 0; cur.h += Number(r.hits) || 0; byDomain.set(d, cur); }
      const rb = [], rp = [], rh = []; let missing = 0;
      for (const a of api.values()) { const dom = String(a.name).replace(/^\d+\.\s*/, "").trim().toLowerCase(); const z = byDomain.get(dom);
        if (!z) { missing++; continue; } if (a.broker_income) rb.push(z.b / a.broker_income); if (a.predicted_income) rp.push(z.p / a.predicted_income); if (a.hits) rh.push(z.h / a.hits); }
      console.log(`== spot (zones): rows=${spots.length} domains=${byDomain.size} sites_without_zones=${missing}`);
      console.log(`   broker_income: zones/site median=${med(rb)} min=${Math.min(...rb).toFixed(3)} max=${Math.max(...rb).toFixed(3)}`);
      console.log(`   predicted_income: zones/site median=${med(rp)} min=${Math.min(...rp).toFixed(3)} max=${Math.max(...rp).toFixed(3)}`);
      console.log(`   hits: zones/site median=${med(rh)} min=${Math.min(...rh).toFixed(3)} max=${Math.max(...rh).toFixed(3)}`);
    } else console.log("== spot (zones): no raw spot file for this day");
    for (const cut of ["network"]) {
      const ratios = {}; let fields = "-";
      for (const [id, a] of api) {
        const rows = latest(cut, id); if (!rows || !rows.length || !a.broker_income) continue;
        fields = Object.keys(rows[0]).join(",");
        for (const k of Object.keys(rows[0])) {
          if (typeof rows[0][k] !== "number") continue;
          const site = Number(a[k]) || 0;
          (ratios[k] ??= []).push(rows.reduce((s, r) => s + (Number(r[k]) || 0), 0) / (site || NaN));
        }
      }
      console.log(`== ${cut}: fields=${fields}`);
      for (const [k, v] of Object.entries(ratios)) console.log(`   ${k}: cut/site median=${med(v)} max=${Math.max(...v.filter(Number.isFinite)).toFixed(3)} sites=${v.length}`);
    }' 2>&1 | grep -v '^   rev=' | head -80
  echo; echo "Requests sent: $REQUESTS."
  exit 0
fi

if [ "${ASG_PROBE_MODE:-}" = "dates" ]; then
  # Does the API honour from/to? group_by=date lists the days a response really covers.
  # Prints dates (not secret), row counts and revenue RATIOS only — never amounts.
  list_dates() { jq -r 'if type=="array" then [.[] | .name // .date // "" | tostring] | join(",") else "-" end' "$OUT/$1.json" 2>/dev/null \
    | sed -E 's/[^0-9,-]/?/g' | cut -c1-200; }
  probe dt_1d "group_by=date";               echo "   dates: $(list_dates dt_1d)"
  FROM=$(date -u -d "$DATE -6 days" +%F) probe dt_7d "group_by=date"; echo "   dates: $(list_dates dt_7d)"
  NO_RANGE=1 probe dt_period "group_by=date&period=${DATE}%20-%20${DATE}"; echo "   dates: $(list_dates dt_period)"
  NO_RANGE=1 probe dt_none "group_by=date";  echo "   dates: $(list_dates dt_none)"
  echo
  echo "== Numeric fields of group_by=website for $DATE, as a ratio of sum(broker_income)"
  jq -r '([.[] | (.broker_income // 0)] | add) as $b | if ($b // 0) == 0 then "broker_income sum is 0" else
    (.[0] | keys[]) as $k | [.[] | .[$k]] as $v | select(($v[0] | type) == "number" and ($k | test("income|revenue|profit|earn|payout|amount"))) |
    "\($k): \(([$v[] // 0] | add) / $b * 1000 | round / 1000)" end' "$OUT/baseline_website.json" 2>/dev/null | sort -u
  echo "website rows: $(jq 'length' "$OUT/baseline_website.json"), distinct ids: $(jq '[.[] | .name // "" | tostring | split(".")[0]] | unique | length' "$OUT/baseline_website.json")"
  if [ -f /opt/tubestat/.current-image ]; then
    api=$(jq '[.[] | (.broker_income // 0)] | add // 0' "$OUT/baseline_website.json")
    echo
    echo "== TubeStat database vs this API response (ratios of revenue, by day)"
    ( cd /opt/tubestat && APP_IMAGE=$(cat .current-image) docker compose exec -T postgres psql -U tubestat -d tubestat -At -F ' ' -c \
      "SELECT date, count(*), count(DISTINCT \"siteId\"), count(*) FILTER (WHERE \"countryCode\" = 'ZZ'), round(SUM(\"revenueReported\") / NULLIF($api, 0), 3)
       FROM \"FactRevenueGeo\" WHERE date BETWEEN DATE '$DATE' - 6 AND DATE '$DATE' + 1 GROUP BY 1 ORDER BY 1" 2>/dev/null \
      | awk '{ printf "   %s rows=%s sites=%s zz_rows=%s db/api=%s\n", $1, $2, $3, $4, $5 }' ) || echo "   database not reachable"
  fi
  echo; echo "Requests sent: $REQUESTS."
  exit 0
fi

if [ "${ASG_PROBE_MODE:-}" = "discover" ]; then
  # Names from the ADOK UI "Group" list and more spellings of its "Website" filter.
  # The ADOK UI sends the Website filter as platforms_ids: ["137648", ...].
  [ -n "$CUT_SITE" ] && for v in "platforms_ids[]=$CUT_SITE" "platforms_ids=$CUT_SITE" "platform_id=$CUT_SITE"; do
    label="fc_$(printf '%s' "${v%%=*}" | tr -c 'a-zA-Z_' '_')"
    probe "$label" "group_by=country&$v"
    filter_ratio "$label"
  done
  [ -n "$CUT_SITE" ] && { probe fc_net_site "group_by=adnetwork_squashed&platforms_ids[]=$CUT_SITE"; filter_ratio fc_net_site; }
  [ -n "$CUT_SITE" ] && { probe fc_spot_site "group_by=spot&platforms_ids[]=$CUT_SITE"; filter_ratio fc_spot_site; }
  for f in "$OUT"/gb_*.json; do
    [ -s "$f" ] || continue
    echo "   $(basename "$f" .json): rows=$(jq 'if type=="array" then length else "-" end' "$f" 2>/dev/null) fields=$(jq -r 'if type=="array" and length>0 then (.[0] | keys | join(",")) else "-" end' "$f" 2>/dev/null | cut -c1-240)"
    echo "   $(basename "$f" .json): names=$(jq -r 'if type=="array" then (.[:4][] | .name // "" | tostring) else empty end' "$f" 2>/dev/null | bash "$SHAPE" | paste -sd '|' -)"
  done
  echo; echo "Requests sent: $REQUESTS."
  exit 0
fi

if [ "${ASG_PROBE_MODE:-}" = "multi" ]; then
  # Two dimensions in one report (site x country)? More rows than the country cut = yes.
  probe mg_comma      "group_by=website,country"
  probe mg_array      "group_by[]=website&group_by[]=country"
  probe mg_repeat     "group_by=website&group_by=country"
  probe mg_reverse    "group_by=country,website"
  [ -n "$CUT_SITE" ] && for v in "site_id=$CUT_SITE" "site_ids[]=$CUT_SITE" "website_id[]=$CUT_SITE" "sites[]=$CUT_SITE"; do
    label="fc_$(printf '%s' "${v%%=*}" | tr -c 'a-z_' '_')"
    probe "$label" "group_by=country&$v"
    filter_ratio "$label"
  done
  for f in "$OUT"/mg_*.json; do
    [ -s "$f" ] || continue
    echo "   $(basename "$f" .json): fields=$(jq -r 'if type=="array" and length>0 then (.[0] | keys | join(",")) else "-" end' "$f" 2>/dev/null | cut -c1-200)"
    echo "   $(basename "$f" .json): names=$(jq -r 'if type=="array" then (.[:2][] | .name // "" | tostring) else empty end' "$f" 2>/dev/null | bash "$SHAPE" | paste -sd '|' -)"
  done
  echo; echo "Requests sent: $REQUESTS."
  exit 0
fi

if [ "${ASG_PROBE_MODE:-}" = "filters" ]; then
  # Which parameter scopes a report to one site? Each variant is checked by the hits ratio.
  [ -n "$CUT_SITE" ] || stop_run "no site id in the baseline to test filters with"
  for v in "website_id=$CUT_SITE" "website_ids[]=$CUT_SITE" "website_ids=$CUT_SITE" "filter[website_id]=$CUT_SITE" "websites[]=$CUT_SITE" "website=$CUT_SITE"; do
    label="fc_$(printf '%s' "${v%%=*}" | tr -c 'a-z_' '_')"
    probe "$label" "group_by=country&$v"
    filter_ratio "$label"
  done
  probe fc_spot "group_by=spot&website_id=$CUT_SITE"
  filter_ratio fc_spot
  echo; echo "Requests sent: $REQUESTS."
  exit 0
fi

# 2. Partner / network dimension: most likely names first, stop at the first that returns rows.
PARTNER=""
if [ "$SKIP_PARTNER" != "1" ]; then
  for g in broker network partner ad_network source; do
    probe "gb_$g" "group_by=$g$site_q"
    if [ "$LAST_CODE" = "200" ] && [[ "$LAST_ROWS" =~ ^[0-9]+$ ]] && [ "$LAST_ROWS" -gt 0 ]; then
      PARTNER="$g"; break
    fi
  done
  echo "partner dimension: ${PARTNER:-not found}"
fi

# 3. Multiple dimensions at once — one syntax at a time, only with a known partner name.
if [ -n "$PARTNER" ]; then
  probe multi_comma  "group_by=$PARTNER,country$site_q"
  [ "$LAST_CODE" = "200" ] || probe multi_array "group_by[]=$PARTNER&group_by[]=country$site_q"
  probe filter_country "group_by=$PARTNER&country=US$site_q"
fi

# 3b. Cuts the ingest is built on: account and per-site country, days, devices.
probe country      "group_by=country"
[ -n "$cut_q" ] && { probe country_site "group_by=country$cut_q"; filter_ratio country_site; }
probe date         "group_by=date"
probe device       "group_by=device$cut_q"

# 4. Cuts the ingest needs regardless.
probe spot    "group_by=spot${cut_q:-$site_q}"
probe ad_type "group_by=ad_type$site_q"
probe filter_ad_type "group_by=spot&ad_type=banner$site_q"

if [ "$REDACT" = "1" ]; then
  echo
  echo "== Structure of non-empty responses (values masked)"
  for f in "$OUT"/*.json; do
    n=$(jq 'if type=="array" then length else 0 end' "$f" 2>/dev/null) || n=0
    [ "${n:-0}" -gt 0 ] 2>/dev/null || continue
    echo "-- $(basename "$f" .json) ($n rows)"
    echo "   fields: $(jq -r '.[0] | keys | join(",")' "$f")"
    echo "   names:  $(jq -r '.[:3][] | .name // "" | tostring' "$f" | bash "$SHAPE" | paste -sd '|' -)"
  done
fi

echo
echo "Requests sent: $REQUESTS. Responses saved to $OUT (no tokens are written to the files)."
