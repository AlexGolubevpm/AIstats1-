#!/usr/bin/env bash
# Probe the AdSpyGlass (adok.ai) report API to find which groupings it supports.
# Usage: ASG_AUTH_EMAIL=... ASG_AUTH_TOKEN=... ./scripts/asg-probe.sh [YYYY-MM-DD] [website_id]
# Saves every response to docs/asg-samples/ (or $ASG_PROBE_OUT) and prints a status summary.
# ASG_PROBE_REDACT=1 prints only structure (status, row counts, field names, masked name
# shapes) — required when output goes to public CI logs.
set -uo pipefail

BASE="${ASG_API_URL:-https://api.adok.ai/api}"
DATE="${1:-$(date -u -d yesterday +%F 2>/dev/null || date -u -v-1d +%F)}"
SITE="${2:-}"
OUT="${ASG_PROBE_OUT:-$(dirname "$0")/../docs/asg-samples}"
REDACT="${ASG_PROBE_REDACT:-0}"
SHAPE="$(dirname "$0")/ci/shape.sh"
mkdir -p "$OUT"

: "${ASG_AUTH_EMAIL:?set ASG_AUTH_EMAIL}"
: "${ASG_AUTH_TOKEN:?set ASG_AUTH_TOKEN}"

probe() {
  local label="$1" query="$2"
  local file="$OUT/${label}.json"
  local code
  code=$(curl -sS -m 60 -o "$file" -w '%{http_code}' \
    -H "X-Asg-Auth-Email: $ASG_AUTH_EMAIL" \
    -H "X-Asg-Auth-Token: $ASG_AUTH_TOKEN" \
    "$BASE/report?from=$DATE&to=$DATE&$query")
  local rows first
  rows=$(jq 'if type=="array" then length else "not-array" end' "$file" 2>/dev/null || echo "?")
  if [ "$REDACT" = "1" ]; then
    if [ "$code" != "200" ]; then
      # Error bodies carry the API's explanation, not report data.
      first=$(head -c 160 "$file" | tr '\n' ' ')
    elif [ "$rows" = "not-array" ]; then
      first="object keys: $(jq -r 'keys | join(",")' "$file" 2>/dev/null | cut -c1-120)"
    else
      first=$(jq -r '.[0].name // "" | tostring' "$file" 2>/dev/null | bash "$SHAPE")
    fi
  else
    first=$(jq -c 'if type=="array" then .[0].name else . end' "$file" 2>/dev/null | cut -c1-80)
  fi
  printf '%-28s %s rows=%-6s first=%s\n' "$label" "$code" "$rows" "$first"
}

site_q=""
[ -n "$SITE" ] && site_q="&website_id=$SITE"

echo "Date: $DATE  Site: ${SITE:-all}"
# Known-good baseline
probe baseline_website       "group_by=website"
# Partner / network dimension — candidate names
for g in broker brokers network networks ad_network partner partners source advertiser campaign; do
  probe "gb_$g" "group_by=$g$site_q"
done
# Multiple dimensions at once — candidate syntaxes
probe multi_comma            "group_by=website,country$site_q"
probe multi_array            "group_by[]=website&group_by[]=country$site_q"
probe multi_repeat           "group_by=website&group_by=country$site_q"
probe multi_broker_country   "group_by=broker,country$site_q"
# Per-site cuts we will need regardless
probe spot                   "group_by=spot$site_q"
probe ad_type                "group_by=ad_type$site_q"
probe country                "group_by=country$site_q"
probe device                 "group_by=device$site_q"
# Filters that would let us cross dimensions via iteration
probe filter_country         "group_by=broker&country=JP$site_q"
probe filter_ad_type         "group_by=spot&ad_type=banner$site_q"

if [ "$REDACT" = "1" ]; then
  echo
  echo "== Structure of non-empty responses (values masked)"
  for f in "$OUT"/*.json; do
    n=$(jq 'if type=="array" then length else 0 end' "$f" 2>/dev/null || echo 0)
    [ "$n" -gt 0 ] || continue
    echo "-- $(basename "$f" .json) ($n rows)"
    echo "   fields: $(jq -r '.[0] | keys | join(",")' "$f")"
    echo "   names:  $(jq -r '.[:3][] | .name // "" | tostring' "$f" | bash "$SHAPE" | paste -sd '|' -)"
  done
fi

echo
echo "Responses saved to $OUT. Share the summary above (no tokens are written to the files)."
