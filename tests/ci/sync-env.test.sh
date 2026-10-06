#!/usr/bin/env bash
# scripts/sync-env.sh on a temp stack dir: writes allowed keys from stdin without printing
# values, generates APP_PASSWORD once, enables the worker, drops COOKIE_SECURE on plain HTTP.
set -euo pipefail
cd "$(dirname "$0")/../.."
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
b64() { printf '%s' "$1" | base64 -w0; }
printf '#!/usr/bin/env bash\ncat >> "%s/psql.log"\n' "$tmp" > "$tmp/psql"; chmod +x "$tmp/psql"
run() { TUBESTAT_DIR="$tmp" RESTART=0 PSQL="$tmp/psql" bash scripts/sync-env.sh; }
fail=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }

printf 'POSTGRES_PASSWORD=keep-me\nAPP_DOMAIN=:80\nCOOKIE_SECURE=1\nASG_AUTH_TOKEN=old\n' > "$tmp/.env"
out=$(printf 'ASG_AUTH_EMAIL %s\nASG_AUTH_TOKEN %s\nPOSTGRES_PASSWORD %s\nMETRIKA_TOKEN \n' \
  "$(b64 me@example.test)" "$(b64 tok-SECRET-123)" "$(b64 hijack)" | run)
env=$(cat "$tmp/.env")
check "keys written"            '[[ "$env" == *"ASG_AUTH_EMAIL=me@example.test"* && "$env" == *"ASG_AUTH_TOKEN=tok-SECRET-123"* ]]'
check "old value replaced"      '[ "$(grep -c "^ASG_AUTH_TOKEN=" "$tmp/.env")" = 1 ]'
check "values never printed"    '[[ "$out" != *SECRET* && "$out" != *example.test* ]]'
check "other keys refused"      '[[ "$env" == *"POSTGRES_PASSWORD=keep-me"* && "$env" != *hijack* ]]'
check "empty value skipped"     '! grep -q "^METRIKA_TOKEN=" "$tmp/.env"'
check "password generated"      '[ "$(grep "^APP_PASSWORD=" "$tmp/.env" | cut -d= -f2- | wc -c)" -gt 16 ]'
check "worker enabled"          'grep -q "^COMPOSE_PROFILES=worker$" "$tmp/.env"'
check "cookie flag dropped"     '! grep -q "^COOKIE_SECURE" "$tmp/.env"'
check "file is private"         '[ "$(stat -c %a "$tmp/.env")" = 600 ]'

pw=$(grep "^APP_PASSWORD=" "$tmp/.env")
out=$(printf 'ASG_AUTH_TOKEN %s\n' "$(b64 tok-SECRET-123)" | run)
check "password kept on re-run" '[ "$(grep "^APP_PASSWORD=" "$tmp/.env")" = "$pw" ]'
check "re-run is a no-op"       '[[ "$out" == *"ASG_AUTH_TOKEN: unchanged"* && "$out" == *"nothing changed"* ]]'
check "no password reset so far" '[ ! -e "$tmp/psql.log" ]'

out=$(printf 'APP_PASSWORD %s\n' "$(b64 NewPass-SECRET-9)" | run)
check "password set from secret"  '[ "$(grep "^APP_PASSWORD=" "$tmp/.env")" = "APP_PASSWORD=NewPass-SECRET-9" ] && [[ "$out" != *SECRET* ]]'
check "stored hash and sessions dropped" 'grep -q "password_hash" "$tmp/psql.log" && grep -q "\"Session\"" "$tmp/psql.log" && [[ "$out" == *"applies at the next login"* ]]'
out=$(printf 'APP_PASSWORD %s\n' "$(b64 NewPass-SECRET-9)" | run)
check "same password: no reset"   '[ "$(grep -c password_hash "$tmp/psql.log")" = 1 ] && [[ "$out" == *"APP_PASSWORD: unchanged"* ]]'
out=$(PSQL=false TUBESTAT_DIR="$tmp" RESTART=0 bash scripts/sync-env.sh <<< "APP_PASSWORD $(b64 Other-SECRET-10)")
check "db unreachable: still written" '[ "$(grep "^APP_PASSWORD=" "$tmp/.env")" = "APP_PASSWORD=Other-SECRET-10" ] && [[ "$out" == *"could not reset"* && "$out" != *SECRET* ]]'

printf 'APP_DOMAIN=stats.example.test\nCOOKIE_SECURE=1\nAPP_PASSWORD=x\nCOMPOSE_PROFILES=foo\n' > "$tmp/.env"
printf '' | run >/dev/null
check "cookie flag kept on HTTPS" 'grep -q "^COOKIE_SECURE=1" "$tmp/.env"'
check "worker added to profiles"  'grep -q "^COMPOSE_PROFILES=foo,worker$" "$tmp/.env"'
out=$(printf 'ASG_AUTH_TOKEN %s\n' "$(b64 "a b")" | run)
check "unsafe value refused"      '[[ "$out" == *"unsupported characters"* ]] && ! grep -q "^ASG_AUTH_TOKEN" "$tmp/.env"'
exit $fail
