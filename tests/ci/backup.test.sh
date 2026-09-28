#!/usr/bin/env bash
# deploy/backup.sh with a stub docker: writes a daily dump, keeps the last KEEP, fails on empty output.
set -euo pipefail
cd "$(dirname "$0")/../.."
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/app/backups"
cat > "$tmp/bin/docker" <<'SH'
#!/usr/bin/env bash
[ -n "${APP_IMAGE:-}" ] || { echo 'required variable APP_IMAGE is missing a value' >&2; exit 1; } # like compose
[ "${EMPTY:-0}" = 1 ] || printf 'PGDMP-fake'
SH
chmod +x "$tmp/bin/docker"
for d in 01 02 03 04; do touch -d "2026-09-$d" "$tmp/app/backups/daily-202609$d.dump"; done
fail=0
PATH="$tmp/bin:$PATH" TUBESTAT_DIR="$tmp/app" KEEP=3 bash deploy/backup.sh >/dev/null
n=$(ls "$tmp/app/backups"/daily-*.dump | wc -l)
[ "$n" = 3 ] && echo "ok   keeps the last 3" || { echo "FAIL kept $n"; fail=1; }
today="$tmp/app/backups/daily-$(date -u +%Y%m%d).dump"
[ -s "$today" ] && echo "ok   today's dump written" || { echo "FAIL no dump for today"; fail=1; }
if PATH="$tmp/bin:$PATH" TUBESTAT_DIR="$tmp/app" EMPTY=1 bash deploy/backup.sh >/dev/null 2>&1; then echo "FAIL empty dump accepted"; fail=1; else echo "ok   empty dump rejected"; fi
exit $fail
