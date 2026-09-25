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
  meta=$(curl -gsS -m 60 -o "$file" -w '%{http_code} %{redirect_url}' \
    -H "X-Asg-Auth-Email: $ASG_AUTH_EMAIL" \
    -H "X-Asg-Auth-Token: $ASG_AUTH_TOKEN" \
    "$BASE/report?from=$DATE&to=$DATE&$query" 2>"$OUT/.curl-error")
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
