# CI/CD: GitHub → Timeweb

```
PR → GitHub Actions: проверки (typecheck, тесты с порогом покрытия 80%, сборка, E2E Playwright, docker build)
merge в main → сборка образа → ghcr.io/alexgolubevpm/tubestat:<sha>
            → SSH на сервер под пользователем deploy
            → /opt/tubestat/deploy.sh: бэкап БД → миграции → справочники (dist/seed.js) → docker compose up → ждём healthcheck
```

На сервере: Docker + `docker compose` со стеком из `deploy/docker-compose.yml`: Caddy (HTTPS), web, worker, Postgres 16, Redis 7. Секреты приложения лежат только в `/opt/tubestat/.env` на сервере; в GitHub — только доступ по SSH.

## Настройка — один раз

### 1. Ключ для GitHub Actions (на своём компьютере)

```bash
ssh-keygen -t ed25519 -N "" -C "github-actions-tubestat" -f ~/.ssh/tubestat_deploy
```

Получится пара: `~/.ssh/tubestat_deploy` (приватный → в GitHub) и `~/.ssh/tubestat_deploy.pub` (публичный → на сервер).

### 2. Подготовка сервера (из корня репозитория)

```bash
IP=<ip сервера>
scp scripts/server-bootstrap.sh root@$IP:
ssh root@$IP "bash server-bootstrap.sh '$(cat ~/.ssh/tubestat_deploy.pub)'"
```

Скрипт: обновления, swap 4 ГБ, firewall (22/80/443), fail2ban, Docker, пользователь `deploy`, каталог `/opt/tubestat`. Вход по паролю выключает, только если у root уже есть SSH-ключ — если ты заходишь по паролю Timeweb, сначала `ssh-copy-id root@$IP`, иначе скрипт оставит пароль включённым и предупредит.

### 3. Секреты приложения на сервере

```bash
ssh root@$IP
nano /opt/tubestat/.env       # шаблон — .env.example в репозитории
```

Минимум для первого деплоя: `POSTGRES_PASSWORD` (`openssl rand -hex 24`) и `APP_DOMAIN` — либо `:80`, пока нет домена, либо `stats.<домен>` после того, как A-запись указывает на IP (Caddy сам получит сертификат).

Для приложения добавить:

| Строка | Зачем |
| --- | --- |
| `APP_PASSWORD=…` | Пароль входа (потом меняется в Настройки → Доступ) |
| `COMPOSE_PROFILES=worker` | Включает воркер ингеста |
| `COOKIE_SECURE=1` | Когда сайт открывается по HTTPS |
| `ASG_AUTH_EMAIL`, `ASG_AUTH_TOKEN` | AdSpyglass; без них воркер пропускает джобы AdSpyglass |
| `METRIKA_TOKEN` | Метрика |

После правки `.env` — `cd /opt/tubestat && docker compose up -d` (или дождаться следующего деплоя).

**Без ручной правки.** Воркфлоу `Sync server .env` (`.github/workflows/sync-env.yml`, вручную или при изменении `.github/sync-env.request`) переносит `ASG_AUTH_EMAIL`, `ASG_AUTH_TOKEN` и `METRIKA_TOKEN` из секретов окружения `production` в `/opt/tubestat/.env`, один раз генерирует `APP_PASSWORD`, если его нет, включает `COMPOSE_PROFILES=worker`, убирает `COOKIE_SECURE=1`, пока сайт открыт по HTTP (`APP_DOMAIN` пустой или `:80`), и перезапускает стек. Значения идут через stdin SSH и в лог не попадают; другие ключи скрипт не трогает. Пароль читается только на сервере: `grep APP_PASSWORD /opt/tubestat/.env`.

### 4. Секреты в GitHub

Repo → Settings → Environments → **New environment** `production` → Environment secrets:

| Секрет | Значение |
| --- | --- |
| `DEPLOY_HOST` | IP сервера |
| `DEPLOY_SSH_KEY` | содержимое `~/.ssh/tubestat_deploy` (приватный, целиком) |
| `DEPLOY_KNOWN_HOSTS` | вывод `ssh-keyscan -t ed25519 <IP>` |

`GITHUB_TOKEN` для реестра образов создаётся автоматически, отдельный токен не нужен.

Для ручного workflow **ASG API probe** (проверка API AdSpyglass, см. [DEPLOYMENT_PLAN](./DEPLOYMENT_PLAN.md#2-расхождения-спецификации-с-реальным-api--решить-до-кода)) в том же environment нужны ещё:

| Секрет | Значение |
| --- | --- |
| `ASG_AUTH_EMAIL` | email аккаунта AdSpyglass |
| `ASG_AUTH_TOKEN` | API-токен AdSpyglass |

Секреты приложения на сервере (`/opt/tubestat/.env`) задаются отдельно — GitHub их туда не копирует.

### 5. Защита main

Settings → Branches → Add rule для `main`: *Require a pull request*, *Require status checks* → `check`. После этого в `main` попадает только то, что прошло проверки.

## Как проходит изменение

1. Работа в ветке, PR в `main` — на PR бегут проверки.
2. Merge → собирается образ, деплой на сервер. Статус — во вкладке Actions.
3. Если healthcheck не прошёл, job падает с логами `web`; прошлые контейнеры Postgres/Redis не трогаются, бэкап БД перед деплоем лежит в `/opt/tubestat/backups` (последние 10).

**Бэкапы.** Перед каждым деплоем — `backups/pre-deploy-*.dump` (последние 10). Ежедневно в 03:30 UTC — `backups/daily-YYYYMMDD.dump` (последние 14): `deploy.sh` ставит cron пользователю `deploy`, скрипт — `deploy/backup.sh`, лог — `backups/backup.log`. Восстановление: `docker compose exec -T postgres pg_restore -U tubestat -d tubestat --clean < backups/<файл>.dump`.

**Проверка готовности прода.** Воркфлоу `Readiness check` (`.github/workflows/readiness.yml`) каждый день в 06:10 UTC, вручную или при изменении `.github/readiness.request` заходит на сервер по SSH и прогоняет чеклист готовности из спецификации: ингест ADOK и Метрики за вчера, задержку данных, долю нераспознанных гео (< 1%), сверку с итогом ADOK (±2%), долю сайт-страна-дней с расходом, равенство бандла сумме сайтов, заполненность ID сайтов, время запроса страницы сайта за 30 дней (< 300 мс), воркер, ежедневные бэкапы и какие ключи не заданы в `/opt/tubestat/.env` (только имена). В лог попадают только счётчики, доли и статусы (`scripts/readiness.sql`, `scripts/readiness.sh`), без доменов и денег. Красный запуск — есть что чинить; GitHub присылает письмо о падении.

Откат на предыдущую версию:

```bash
ssh deploy@$IP 'bash /opt/tubestat/deploy.sh ghcr.io/alexgolubevpm/tubestat:<старый sha>'
```

## Требования к приложению

Чтобы деплой проходил, образ должен:
- слушать порт `3000`;
- отвечать `200` на `GET /api/health`;
- содержать `prisma/migrations` и Prisma CLI (`npx --no-install prisma migrate deploy`);
- содержать `dist/seed.js` (справочники, идемпотентно) и `dist/worker.js`; воркер включается строкой `COMPOSE_PROFILES=worker` в `.env`;
- собираться без базы: `next build` не должен подключаться к Postgres (клиент Prisma создаётся при первом запросе).

Сырьё API без S3 лежит в томе `raw_data` (`/data/raw` в web и worker).
