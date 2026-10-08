# TubeStat на https://xhubtraffic.com/admin — инструкция

Домен пустой и целиком отдаётся нашему серверу. Девопсам нужно только поменять DNS; сертификат, редиректы и путь `/admin` настраивает наш деплой ([CICD → Домен и базовый путь](../CICD.md#domain), [ADR 0014](../adr/0014-base-path.md)).

## 1. Девопсам: DNS (две записи)

В зоне `xhubtraffic.com`:

| Тип | Имя | Значение |
| --- | --- | --- |
| A | `@` | `129.101.120.123` |
| A | `www` | `129.101.120.123` |

- TTL любой (Auto). Старые записи `A` / `AAAA` / `CNAME` для `@` и `www` удалить (иначе часть запросов уйдёт на старый сервер).
- **Прокси (Cloudflare).** Предпочтительно без проксирования (серое облако, «DNS only»): Caddy на сервере сам получает сертификат Let's Encrypt и видит реальные IP посетителей. Если записи остаются проксированными (оранжевое облако) — в Cloudflare → SSL/TLS выставить режим **Full** (после выпуска сертификата на сервере можно **Full (strict)**); проверку Let's Encrypt по `/.well-known/acme-challenge/` Cloudflare пропускает к серверу, так что сертификат появится и так. Режим Flexible не подходит: приложение ставит Secure-куки и ждёт HTTPS.
- Больше ничего открывать и настраивать не нужно: на сервере уже открыты 80 и 443, остальное закрыто.
- Проверка и сигнал нам: `dig +short xhubtraffic.com` и `dig +short www.xhubtraffic.com` отвечают `129.101.120.123`.

## 2. Наша сторона (после DNS, 5 минут)

1. GitHub → репозиторий → Settings → Secrets and variables → Actions → вкладка **Variables** → добавить:
   - `APP_DOMAIN` = `xhubtraffic.com`
   - `APP_BASE_PATH` = `/admin`
2. Запустить деплой: Actions → `CI/CD` → последний запуск на `main` → **Re-run all jobs** (или смержить любой PR). Деплой пересоберёт образ под `/admin`, допишет `.env` на сервере, переключит Caddy на `Caddyfile.basepath`; сертификат появится в течение минуты после старта.

## 3. Проверка

| Запрос | Ожидание |
| --- | --- |
| `https://xhubtraffic.com/admin/api/health` | 200, JSON со статусом |
| `https://xhubtraffic.com/` | редирект на `/admin` → форма входа `/admin/login` |
| `https://xhubtraffic.com/admin` | вход работает, после входа все ссылки начинаются с `/admin/` |
| `https://xhubtraffic.com/robots.txt` | `Disallow: /` |
| `https://xhubtraffic.com/anything` | 404 |
| `http://129.101.120.123/` | больше не открывает UI: Caddy обслуживает только `xhubtraffic.com` |

На сервере: `cd /opt/tubestat && docker compose ps` — `web` в состоянии `healthy`, `docker compose logs caddy --tail 50` — без ошибок получения сертификата.

## 4. Что меняется для пользователей

- Адрес: `https://xhubtraffic.com/admin`. Логин и пароль прежние.
- MCP-URL для Claude: `https://xhubtraffic.com/admin/api/mcp` (показан в Настройки → Доступ).
- Куки сессии действуют только внутри `/admin`.

## 5. Откат

Очистить переменные `APP_DOMAIN` и `APP_BASE_PATH` в GitHub и перезапустить деплой — приложение снова по IP в корне. DNS можно не трогать.
