#!/usr/bin/env bash
# Writes the public address of the app into /opt/tubestat/.env from the environment of the deploy call:
#   APP_DOMAIN  — host Caddy serves (xhubtraffic.com) or ":80" for plain HTTP by IP
#   BASE_PATH   — "" (root) or "/admin"
# Derived: APP_URL (links in MCP answers), COOKIE_SECURE (1 on a real domain, dropped on :80),
# CADDYFILE (Caddyfile.basepath when BASE_PATH is set). Empty inputs leave those untouched.
# Always: APP_SECRET — the key for secrets the UI stores in the database (ADR 0018) — is generated
# once when missing and never rewritten (a new key would make the stored secrets unreadable).
# Nothing is printed: the output lands in a public CI log (docs/CICD.md#domain).
set -euo pipefail
DIR="${TUBESTAT_DIR:-/opt/tubestat}"
ENV_FILE="$DIR/.env"
[ -f "$ENV_FILE" ] || { umask 077; : > "$ENV_FILE"; }

upsert() { # key value — replace the line or append it, once
  local key="$1" value="$2" tmp
  tmp=$(mktemp); grep -v "^${key}=" "$ENV_FILE" > "$tmp" || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  cat "$tmp" > "$ENV_FILE"; rm -f "$tmp"
}
drop() { local tmp; tmp=$(mktemp); grep -v "^$1=" "$ENV_FILE" > "$tmp" || true; cat "$tmp" > "$ENV_FILE"; rm -f "$tmp"; }

if ! grep -q "^APP_SECRET=." "$ENV_FILE"; then
  drop APP_SECRET
  printf 'APP_SECRET=%s\n' "$(openssl rand -hex 32)" >> "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi

domain="${APP_DOMAIN:-}"
base="${BASE_PATH:-}"
[ -n "$domain" ] || [ -n "$base" ] || exit 0

if [ -n "$domain" ]; then
  upsert APP_DOMAIN "$domain"
  case "$domain" in
    :*) drop COOKIE_SECURE ;;
    *) upsert COOKIE_SECURE 1 ;;
  esac
fi
# BASE_PATH is written even when empty, so switching back to the root clears it.
base="${base%/}"
upsert BASE_PATH "$base"
if [ -n "$base" ]; then upsert CADDYFILE Caddyfile.basepath; else upsert CADDYFILE Caddyfile; fi
eff_domain=$(grep "^APP_DOMAIN=" "$ENV_FILE" | tail -1 | cut -d= -f2-)
case "$eff_domain" in
  ""|:*) ;;
  *) upsert APP_URL "https://${eff_domain}${base}" ;;
esac
chmod 600 "$ENV_FILE"
echo "env: domain and base path applied"
