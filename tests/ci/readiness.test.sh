#!/usr/bin/env bash
# scripts/readiness.sh with a stub docker: turns psql rows into a table, adds the page-query
# timing, worker and backup checks, and exits non-zero when any check FAILs.
set -euo pipefail
cd "$(dirname "$0")/../.."
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/app/backups"
cat > "$tmp/bin/docker" <<'SH'
#!/usr/bin/env bash
[ -n "${APP_IMAGE:-}" ] || { echo 'required variable APP_IMAGE is missing a value' >&2; exit 1; } # like compose
args="$*"
case "$args" in
  *"ps --status running worker"*) [ "${WORKER:-up}" = up ] && echo "tubestat-worker-1  running" ;;
  *EXPLAIN*) echo '[{"Plan": {}, "Execution Time": '"${PAGE_MS:-42.7}"'}]' ;;
  *psql*) cat >/dev/null; printf 'ingest adspyglass yesterday|%s|%s\n' "${ASG:-ok}" "$([ "${ASG:-ok}" = ok ] && echo PASS || echo FAIL)"
          echo 'active deals direct / via asg|1 / 2|INFO' ;;
esac
SH
chmod +x "$tmp/bin/docker"
touch "$tmp/app/backups/daily-20260928.dump"
run() { PATH="$tmp/bin:$PATH" TUBESTAT_DIR="$tmp/app" bash scripts/readiness.sh "$PWD/scripts/readiness.sql"; }
fail=0
if out=$(run); then echo "ok   all green exits 0"; else echo "FAIL all green exited non-zero"; echo "$out"; fail=1; fi
grep -q "site page 30d totals query ms.*43 *PASS" <<<"$out" && echo "ok   page timing parsed" || { echo "FAIL page timing: $out"; fail=1; }
grep -q "worker container *running *PASS" <<<"$out" && echo "ok   worker detected" || { echo "FAIL worker"; fail=1; }
grep -q "daily backups: count / newest age h *1 / 0 *PASS" <<<"$out" && echo "ok   backup age" || { echo "FAIL backups: $out"; fail=1; }
! grep -q '|' <<<"$out" && echo "ok   rendered as a table" || { echo "FAIL raw separators"; fail=1; }
if ASG=failed run >/dev/null; then echo "FAIL a failed check exited 0"; fail=1; else echo "ok   a failed check exits 1"; fi
if PAGE_MS=450 run >/dev/null; then echo "FAIL slow page accepted"; fail=1; else echo "ok   slow page fails"; fi
if WORKER=down run >/dev/null; then echo "FAIL stopped worker accepted"; fail=1; else echo "ok   stopped worker fails"; fi
exit $fail
