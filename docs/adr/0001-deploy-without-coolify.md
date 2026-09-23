# 0001. Деплой через GitHub Actions и docker compose, без Coolify

- Статус: принято
- Дата: 2026-09-23

## Контекст

Спецификация предполагала деплой через Coolify. На выделенном сервере Timeweb Coolify нет и ставить его не планируется. Нужна цепочка «PR → проверки → merge → изменения на сервере» без ручных шагов.

## Решение

GitHub Actions: на PR — проверки; на merge в `main` — сборка образа в GHCR, SSH на сервер под пользователем `deploy`, `deploy/deploy.sh` (бэкап базы, миграции, `docker compose up`, ожидание healthcheck). Стек на сервере — `deploy/docker-compose.yml`: Caddy, web, worker, Postgres, Redis. Подробности — [`CICD.md`](../CICD.md).

## Альтернативы

- Coolify — лишний слой управления на сервере, отклонено владельцем.
- Сборка на сервере (`git pull && docker build`) — нагружает сервер, требует доступа сервера к GitHub, нет проверки до деплоя.

## Последствия

- Секреты деплоя в environment `production` на GitHub, секреты приложения — в `/opt/tubestat/.env`.
- Бэкапы Postgres делаем сами: `pg_dump` перед деплоем и ежедневный cron.
- Откат — повторный запуск `deploy.sh` с предыдущим SHA.
