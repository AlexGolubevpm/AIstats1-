#!/usr/bin/env bash
# Runs on the server as `deploy` (from .github/workflows/sync-env.yml over SSH). Reads
# `KEY base64(value)` lines on stdin and writes them into /opt/tubestat/.env, then makes
# sure the stack can start: APP_PASSWORD (generated once if missing), COMPOSE_PROFILES=worker,
# and no COOKIE_SECURE=1 while the site is served over plain HTTP. Never prints a value.
# A provided APP_PASSWORD replaces the login password: the hash stored in the database and all
# sessions are dropped, so the next login re-initialises from the new value.
# Env: TUBESTAT_DIR (default /opt/tubestat), RESTART=0 to skip restarting the stack,
# PSQL (command that reads SQL on stdin; default: psql inside the postgres container).
set -euo pipefail
cd "${TUBESTAT_DIR:-/opt/tubestat}"
umask 077
touch .env && chmod 600 .env
ALLOWED='^(ASG_AUTH_EMAIL|ASG_AUTH_TOKEN|METRIKA_TOKEN|APP_PASSWORD)$'
PSQL="${PSQL:-docker compose exec -T postgres psql -U tubestat -d tubestat -v ON_ERROR_STOP=1 -q}"
changed=0
password_reset=0

get_key() { grep "^$1=" .env | head -n1 | cut -d= -f2- || true; }
del_key() { local t; t=$(mktemp .env.XXXXXX); grep -v "^$1=" .env > "$t" || true; mv "$t" .env; }
set_key() { del_key "$1"; printf '%s=%s\n' "$1" "$2" >> .env; changed=1; }

while read -r key b64 || [ -n "${key:-}" ]; do
  [ -n "${key:-}" ] || continue
  if ! [[ "$key" =~ $ALLOWED ]]; then echo "skipped a key that is not allowed"; continue; fi
  [ -n "${b64:-}" ] || { echo "$key: empty, left as is"; continue; }
  val=$(printf '%s' "$b64" | base64 -d 2>/dev/null | tr -d '\r\n') || { echo "$key: not valid base64, left as is"; continue; }
  if [[ -z "$val" || "$val" =~ [[:space:]\'\"#] ]]; then echo "$key: unsupported characters, left as is"; continue; fi
  if [ "$(get_key "$key")" = "$val" ]; then echo "$key: unchanged"; else set_key "$key" "$val"; echo "$key: updated"; [ "$key" = APP_PASSWORD ] && password_reset=1; fi
done

if [ "$password_reset" = 1 ]; then
  # The app keeps a bcrypt hash of the first APP_PASSWORD it saw; drop it (and every session)
  # so the new value applies at the next login. Tables may not exist before the first deploy.
  if printf '%s\n' "DELETE FROM \"AppSetting\" WHERE key = 'password_hash';" "DELETE FROM \"Session\";" | $PSQL >/dev/null 2>&1; then
    echo "APP_PASSWORD: stored hash and sessions dropped, the new password applies at the next login"
  else
    echo "APP_PASSWORD: could not reset the stored hash (database not reachable); the new value applies after the first deploy"
  fi
fi

if [ -z "$(get_key APP_PASSWORD)" ]; then
  set_key APP_PASSWORD "$(head -c 24 /dev/urandom | base64 | tr -d '/+=\n' | head -c 24)"
  echo "APP_PASSWORD: generated (read it on the server: grep APP_PASSWORD /opt/tubestat/.env)"
else
  echo "APP_PASSWORD: present"
fi

profiles=$(get_key COMPOSE_PROFILES)
if [[ ",$profiles," != *,worker,* ]]; then set_key COMPOSE_PROFILES "${profiles:+$profiles,}worker"; echo "COMPOSE_PROFILES: worker enabled"; fi

domain=$(get_key APP_DOMAIN)
if [[ -z "$domain" || "$domain" == :* ]] && [ "$(get_key COOKIE_SECURE)" = 1 ]; then
  del_key COOKIE_SECURE; changed=1
  echo "COOKIE_SECURE: removed (the site is served over plain HTTP, a secure cookie would block login)"
fi

if [ "$changed" = 1 ] && [ "${RESTART:-1}" = 1 ]; then
  export APP_IMAGE="${APP_IMAGE:-$(cat .current-image)}"
  echo "==> Restart stack"
  docker compose up -d --remove-orphans >/dev/null
  for i in $(seq 1 40); do
    status=$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q web)" 2>/dev/null || echo unknown)
    [ "$status" = healthy ] && { echo "web is healthy"; break; }
    [ "$i" = 40 ] && { echo "web did not become healthy"; exit 1; }
    sleep 3
  done
  docker compose ps --status running worker 2>/dev/null | grep -q worker && echo "worker is running" || echo "worker is not running"
elif [ "$changed" = 0 ]; then
  echo "nothing changed"
fi
