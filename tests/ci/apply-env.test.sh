#!/usr/bin/env bash
# deploy/apply-env.sh on a temp stack dir: writes the domain and base path from the deploy call's
# environment into .env once, derives APP_URL / COOKIE_SECURE / CADDYFILE, prints no values.
set -euo pipefail
cd "$(dirname "$0")/../.."
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
run() { TUBESTAT_DIR="$tmp" bash deploy/apply-env.sh; }
fail=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }

printf 'POSTGRES_PASSWORD=keep-me\nAPP_DOMAIN=:80\nCOOKIE_SECURE=1\n' > "$tmp/.env"
out=$(run)
check "nothing given → untouched"   '[ "$(cat "$tmp/.env")" = "$(printf "POSTGRES_PASSWORD=keep-me\nAPP_DOMAIN=:80\nCOOKIE_SECURE=1")" ] && [ -z "$out" ]'

out=$(APP_DOMAIN=stats.example.test BASE_PATH=/admin run)
env=$(cat "$tmp/.env")
check "domain written once"        '[ "$(grep -c "^APP_DOMAIN=" "$tmp/.env")" = 1 ] && grep -q "^APP_DOMAIN=stats.example.test$" "$tmp/.env"'
check "base path written"          'grep -q "^BASE_PATH=/admin$" "$tmp/.env"'
check "url derived"                'grep -q "^APP_URL=https://stats.example.test/admin$" "$tmp/.env"'
check "cookie secure on https"     '[ "$(grep -c "^COOKIE_SECURE=1$" "$tmp/.env")" = 1 ]'
check "caddyfile for base path"    'grep -q "^CADDYFILE=Caddyfile.basepath$" "$tmp/.env"'
check "other keys kept"            'grep -q "^POSTGRES_PASSWORD=keep-me$" "$tmp/.env"'
check "values never printed"       '[[ "$out" != *example.test* && "$out" != *admin* ]]'
check "file is private"            '[ "$(stat -c %a "$tmp/.env")" = 600 ]'

APP_DOMAIN=stats.example.test BASE_PATH=/admin/ run >/dev/null
check "trailing slash dropped"     'grep -q "^BASE_PATH=/admin$" "$tmp/.env" && [ "$(grep -c "^BASE_PATH=" "$tmp/.env")" = 1 ]'

APP_DOMAIN=:80 BASE_PATH= run >/dev/null
check "back to ip: base cleared"   'grep -q "^BASE_PATH=$" "$tmp/.env" && grep -q "^CADDYFILE=Caddyfile$" "$tmp/.env"'
check "back to ip: no cookie flag" '! grep -q "^COOKIE_SECURE" "$tmp/.env"'
check "back to ip: url untouched"  'grep -q "^APP_URL=https://stats.example.test/admin$" "$tmp/.env"' # a stale URL is harmless; the owner edits it by hand if needed

grep -q 'redir / {$BASE_PATH} 302' deploy/Caddyfile.basepath && grep -q 'handle {$BASE_PATH}/\*' deploy/Caddyfile.basepath && grep -q 'Disallow: /' deploy/Caddyfile.basepath \
  && echo "ok   Caddyfile.basepath redirects the root, proxies the base path and blocks robots" || { echo "FAIL Caddyfile.basepath"; fail=1; }
grep -q 'CADDYFILE:-Caddyfile' deploy/docker-compose.yml && grep -q 'BASE_PATH:-}/api/health' deploy/docker-compose.yml \
  && echo "ok   compose picks the Caddyfile and checks health under the base path" || { echo "FAIL docker-compose.yml"; fail=1; }
grep -q 'deploy/Caddyfile.basepath deploy/deploy.sh deploy/apply-env.sh' .github/workflows/ci.yml && grep -q "BASE_PATH='\${{ vars.APP_BASE_PATH }}'" .github/workflows/ci.yml \
  && echo "ok   ci uploads the new stack files and passes the variables" || { echo "FAIL ci.yml"; fail=1; }
exit $fail
