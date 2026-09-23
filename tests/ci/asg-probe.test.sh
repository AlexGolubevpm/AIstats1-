#!/usr/bin/env bash
# Runs scripts/asg-probe.sh against a local fake ADOK API and checks that redacted
# output (what goes to public CI logs) never contains domains, revenue or credentials.
set -euo pipefail
cd "$(dirname "$0")/../.."
tmp=$(mktemp -d)
port=$((20000 + RANDOM % 20000))
cat > "$tmp/server.py" <<'PY'
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        q = parse_qs(urlparse(self.path).query)
        if self.headers.get("X-Asg-Auth-Token") != "tok-SECRET":
            # Real ADOK answers bad credentials with a redirect to its login page.
            self.send_response(302); self.send_header("Location", "https://example.test/login?next=%2Fapi"); self.end_headers()
            return
        g = q.get("group_by", [""])[0]
        if g == "website":
            return self.reply(200, [{"name": "137648. secretdomain.com", "hits": 5, "broker_income": 987.65}])
        if g == "broker":
            return self.reply(200, [{"name": "AdPulsar", "hits": 3, "broker_income": 123.45}])
        return self.reply(400, {"error": "Unknown group_by"})
    def reply(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.end_headers()
        self.wfile.write(data)
HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
PY
python3 "$tmp/server.py" "$port" & pid=$!
trap 'kill $pid 2>/dev/null; rm -rf "$tmp"' EXIT
for _ in $(seq 50); do curl -s --noproxy '*' "http://127.0.0.1:$port/" >/dev/null 2>&1 && break; sleep 0.1; done

run_probe() {
  NO_PROXY='*' no_proxy='*' ASG_API_URL="http://127.0.0.1:$port" ASG_AUTH_EMAIL=me@example.com ASG_AUTH_TOKEN="$1" \
    ASG_PROBE_OUT="$tmp/out-$2" ASG_PROBE_REDACT=1 bash scripts/asg-probe.sh 2026-09-22 2>&1
}
# Token pasted with a trailing newline, as happens with web forms: must still authenticate.
out=$(run_probe $'tok-SECRET\n' good)
fail=0
expect()   { if grep -qF -- "$2" <<<"$out"; then echo "ok   $1"; else echo "FAIL $1: missing '$2'"; fail=1; fi; }
forbid()   { if grep -qF -- "$2" <<<"$out"; then echo "FAIL $1: leaked '$2'"; fail=1; else echo "ok   $1"; fi; }
expect "baseline status and rows" "baseline_website             200 rows=1"
expect "masked website name"      "999999. aaaaaaaaaaaa.aaa"
expect "broker probe detected"    "gb_broker                    200 rows=1"
expect "fields listed"            "fields: broker_income,hits,name"
expect "error body shown"         "Unknown group_by"
forbid "no domain"                "secretdomain"
forbid "no revenue"               "987.65"
forbid "no network name"          "AdPulsar"
forbid "no token"                 "tok-SECRET"
forbid "no email"                 "me@example.com"
expect "whitespace reported"      "ASG_AUTH_TOKEN: length=11 whitespace=yes"
expect "length after strip"       "ASG_AUTH_TOKEN length=10 non-alphanumeric=1"
forbid "no shell errors"          "integer expression expected"

# Wrong token: every probe is redirected; the log must show where, but not the query string.
out=$(run_probe wrong bad)
expect "redirect shown"           "302 rows=empty  first=redirect -> https://example.test/login"
forbid "redirect query stripped"  "next="
forbid "no shell errors (302)"    "integer expression expected"
[ $fail -eq 0 ] || { echo "---- output"; echo "$out"; }
exit $fail
