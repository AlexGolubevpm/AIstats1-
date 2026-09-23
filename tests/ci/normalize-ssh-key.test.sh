#!/usr/bin/env bash
# Tests for scripts/ci/normalize-ssh-key.sh. Requires ssh-keygen (present on GitHub runners).
set -euo pipefail
cd "$(dirname "$0")/../.."
SCRIPT=scripts/ci/normalize-ssh-key.sh
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

ssh-keygen -q -t ed25519 -N "" -C test -f "$tmp/key"
expected_pub=$(cut -d' ' -f1,2 "$tmp/key.pub")
fail=0

check() {
  local name="$1" input="$2"
  if ! printf '%s' "$input" | bash "$SCRIPT" > "$tmp/out" 2> "$tmp/err"; then
    echo "FAIL $name: script exited non-zero: $(cat "$tmp/err")"; fail=1; return
  fi
  chmod 600 "$tmp/out"
  local got
  got=$(ssh-keygen -y -f "$tmp/out" 2>&1 | cut -d' ' -f1,2) || true
  if [ "$got" = "$expected_pub" ]; then echo "ok   $name"; else echo "FAIL $name: $got"; fail=1; fi
}

clean=$(cat "$tmp/key")
check "clean key"               "$clean"
check "CRLF line endings"       "$(printf '%s' "$clean" | sed 's/$/\r/')"
check "indented lines"          "$(printf '%s' "$clean" | sed 's/^/   /')"
check "trailing spaces"         "$(printf '%s' "$clean" | sed 's/$/  /')"
check "no trailing newline"     "$(printf '%s' "$clean")"
check "collapsed to one line"   "$(printf '%s' "$clean" | tr '\n' ' ')"
check "surrounding blank lines" "$(printf '\n\n%s\n\n\n' "$clean")"

if printf 'not a key' | bash "$SCRIPT" >/dev/null 2>&1; then
  echo "FAIL garbage input: expected non-zero exit"; fail=1
else
  echo "ok   garbage input rejected"
fi

exit $fail
