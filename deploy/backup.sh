#!/usr/bin/env bash
# Daily database backup, installed as a cron job of the deploy user by deploy.sh.
# Keeps the last ${KEEP:-14} daily dumps in /opt/tubestat/backups (pre-deploy dumps are separate).
set -euo pipefail
cd "${TUBESTAT_DIR:-/opt/tubestat}"
# compose interpolates ${APP_IMAGE:?} even for exec/ps; outside deploy.sh take the deployed one.
export APP_IMAGE="${APP_IMAGE:-$(cat .current-image 2>/dev/null || echo unset)}"
KEEP="${KEEP:-14}"
mkdir -p backups
file="backups/daily-$(date -u +%Y%m%d).dump"
docker compose exec -T postgres pg_dump -U tubestat -d tubestat -Fc > "$file.tmp"
[ -s "$file.tmp" ] || { rm -f "$file.tmp"; echo "backup is empty" >&2; exit 1; }
mv "$file.tmp" "$file"
ls -1t backups/daily-*.dump | tail -n +$((KEEP + 1)) | xargs -r rm --
echo "backup ok: $file ($(du -h "$file" | cut -f1))"
