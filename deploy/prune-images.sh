#!/usr/bin/env bash
# Keeps the last ${KEEP_IMAGES:-3} deployed app images (the running one and two to roll back to) and
# removes every other tag of the app repository, then dangling layers. Called by deploy.sh after a
# healthy start. Usage: prune-images.sh <image just deployed>
set -euo pipefail
cd "${TUBESTAT_DIR:-/opt/tubestat}"
IMAGE="$1"
KEEP="${KEEP_IMAGES:-3}"
repo="${IMAGE%:*}"
# First run: no history yet → seed it with the newest local tags (docker lists newest first) so rollback targets survive.
[ -s .image-history ] || { docker images "$repo" --format '{{.Repository}}:{{.Tag}}' | grep -v ':<none>$' | head -n "$KEEP" | tac > .image-history || true; }
# .image-history: deployed images, oldest first, no repeats (a redeploy of the same sha moves it to the end)
{ grep -vxF "$IMAGE" .image-history 2>/dev/null || true; echo "$IMAGE"; } | tail -n "$KEEP" > .image-history.tmp
mv .image-history.tmp .image-history
removed=0
for img in $(docker images "$repo" --format '{{.Repository}}:{{.Tag}}' | grep -v ':<none>$' || true); do
  grep -qxF "$img" .image-history && continue
  docker rmi "$img" >/dev/null 2>&1 && removed=$((removed + 1)) || true
done
docker image prune -f >/dev/null 2>&1 || true
echo "images: kept $(wc -l < .image-history), removed $removed"
