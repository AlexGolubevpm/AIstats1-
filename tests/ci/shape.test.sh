#!/usr/bin/env bash
# Tests for scripts/ci/shape.sh — the masking used before anything reaches public CI logs.
set -euo pipefail
cd "$(dirname "$0")/../.."
fail=0
check() {
  local name="$1" input="$2" expected="$3" got
  got=$(printf '%s\n' "$input" | bash scripts/ci/shape.sh)
  if [ "$got" = "$expected" ]; then echo "ok   $name"; else echo "FAIL $name: got '$got' want '$expected'"; fail=1; fi
}
check "website name"  "137648. japan-tube.com"              "999999. aaaaa-aaaa.aaa"
check "spot name"     "491410. Banners_Footer_A (x.com)"    "999999. Aaaaaaa_Aaaaaa_A (a.aaa)"
check "date"          "2026-09-22"                          "9999-99-99"
check "non-ascii"     "Åland Curaçao"                       "Aaaaa Aaaaaaa"
check "money"         "123.4567"                            "999.9999"
check "truncation"    "$(printf 'x%.0s' $(seq 1 100))"      "$(printf 'a%.0s' $(seq 1 80))"
# Nothing alphanumeric survives
leak=$(printf 'secret-domain.com 42\n' | bash scripts/ci/shape.sh | tr -d 'aA9 .-')
if [ -z "$leak" ]; then echo "ok   no alphanumerics leak"; else echo "FAIL leak: $leak"; fail=1; fi
exit $fail
