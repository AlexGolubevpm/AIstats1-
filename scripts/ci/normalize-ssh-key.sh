#!/usr/bin/env bash
# Reads an OpenSSH private key from stdin and prints it in canonical form.
# Keys pasted into GitHub secrets from web consoles often arrive with CRLF line
# endings, indentation, trailing spaces or with the body collapsed onto one line;
# ssh then fails with "error in libcrypto". We rebuild the PEM armor from scratch.
set -euo pipefail

raw=$(tr -d '\r')

header=$(printf '%s' "$raw" | grep -o -- '-----BEGIN [A-Z ]*PRIVATE KEY-----' | head -n1 || true)
footer=$(printf '%s' "$raw" | grep -o -- '-----END [A-Z ]*PRIVATE KEY-----' | head -n1 || true)
if [ -z "$header" ] || [ -z "$footer" ]; then
  echo "normalize-ssh-key: no BEGIN/END PRIVATE KEY markers found" >&2
  exit 1
fi

body=${raw#*"$header"}
body=${body%%"$footer"*}
body=$(printf '%s' "$body" | tr -d '[:space:]')
if [ -z "$body" ]; then
  echo "normalize-ssh-key: key body is empty" >&2
  exit 1
fi

printf '%s\n' "$header"
printf '%s' "$body" | fold -w 70
printf '\n%s\n' "$footer"
