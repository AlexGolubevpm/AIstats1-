# CI/CD: GitHub → Timeweb

```
PR → GitHub Actions: проверки (typecheck, lint, test, docker build)
merge в main → сборка образа → ghcr.io/alexgolubevpm/tubestat:<sha>
            → SSH на сервер под пользователем deploy
            → /opt/tubestat/deploy.sh: бэкап БД → миграции → docker compose up → ждём healthcheck
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

Откат на предыдущую версию:

```bash
ssh deploy@$IP 'bash /opt/tubestat/deploy.sh ghcr.io/alexgolubevpm/tubestat:<старый sha>'
```

## Требования к приложению

Чтобы деплой проходил, образ должен:
- слушать порт `3000`;
- отвечать `200` на `GET /api/health`;
- содержать `prisma/migrations` и Prisma CLI, если есть миграции;
- для воркера — `dist/worker.js`; включается строкой `COMPOSE_PROFILES=worker` в `.env`.

Пока в репозитории нет `Dockerfile`, job `deploy` проходит вхолостую.
