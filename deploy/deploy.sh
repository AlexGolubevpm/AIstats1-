#!/usr/bin/env bash
# Runs on the server as `deploy`, invoked by GitHub Actions over SSH.
# Usage: deploy.sh <image>   e.g. ghcr.io/alexgolubevpm/tubestat:<sha>
set -euo pipefail
cd /opt/tubestat

IMAGE="$1"
export APP_IMAGE="$IMAGE"

echo "==> Pull $IMAGE"
docker compose pull web
[ -n "${COMPOSE_PROFILES:-}" ] || grep -q "^COMPOSE_PROFILES=" .env 2>/dev/null || echo "note: worker is off (COMPOSE_PROFILES=worker not set in .env)"

echo "==> Backup database"
if docker compose ps --status running postgres | grep -q postgres; then
  docker compose exec -T postgres pg_dump -U tubestat -d tubestat -Fc > "backups/pre-deploy-$(date -u +%Y%m%dT%H%M%S).dump"
  ls -1t backups/pre-deploy-*.dump | tail -n +11 | xargs -r rm --
fi

echo "==> Start dependencies"
docker compose up -d postgres redis

echo "==> Migrations"
docker compose run --rm --no-deps web sh -c 'if [ -d prisma/migrations ]; then npx --no-install prisma migrate deploy; else echo "no migrations"; fi'

echo "==> Reference data"
docker compose run --rm --no-deps web sh -c 'if [ -f dist/seed.js ]; then node dist/seed.js; fi'

echo "==> Start app"
docker compose up -d --remove-orphans

echo "==> Wait for health"
for i in $(seq 1 40); do
  status=$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q web)" 2>/dev/null || echo unknown)
  [ "$status" = "healthy" ] && { echo "web is healthy"; break; }
  [ "$i" = 40 ] && { echo "web did not become healthy"; docker compose logs --tail 100 web; exit 1; }
  sleep 3
done

echo "$IMAGE" > .current-image
docker image prune -af --filter "until=168h" >/dev/null || true
echo "==> Deployed $IMAGE"
