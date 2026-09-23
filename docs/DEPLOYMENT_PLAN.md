# TubeStat — план развертывания в AIstats1-

2026-09-23 · основан на анализе репозитория `adkai` и спецификации [`tubestat-spec.md`](./tubestat-spec.md)

---

## 1. Что реально делает adkai с внешними API

### 1.1 AdSpyGlass — `src/lib/adspyglass.ts`

| Параметр | Как в adkai (работает в проде) | Как в спецификации |
| --- | --- | --- |
| Endpoint | `GET https://api.adok.ai/api/report` (env `ASG_API_URL`) | `POST ADSG_ENDPOINT` |
| Авторизация | заголовки `X-Asg-Auth-Email` + `X-Asg-Auth-Token` | `Authorization: Bearer` |
| Параметры | query: `from`, `to`, `group_by`, `website_id` | JSON body |
| `group_by` | **одно** значение: `date \| website \| spot \| ad_type \| country \| device \| browser \| hour` | массив `site, network, country, device` |
| Фильтры | только `website_id` | — |
| Ответ | массив строк `{ name, ...метрики }` | `json.rows` |

Ключи строки ответа (`AsgReportRow`), которые нам нужны:

| Поле ASG | Поле TubeStat |
| --- | --- |
| `hits` | `pageLoads` |
| `impressions` | `impsOwn` |
| `broker_hits` / `discrepancy_imp` | `impsNetwork` (уточнить, что из двух) |
| `clicks` | `clicks` |
| `broker_income` | `revenueReported` |
| `predicted_income` | не храним в факте, можно в сыром |
| `banner_view_rate` × `impressions` | `views` (прямой колонки «Banner views» в ответе нет) |
| `requests`, `fill_rate` | fill rate считаем сами по `impsOwn / pageLoads` |

Формат `name` зависит от разреза: `website` → `"137648. domain.com"`, `spot` → `"491410. Banners_Footer_A (domain.com)"`, `date` → дата. Парсеры `parseWebsiteName` / `parseSpotName` переносим как есть.

Как adkai вызывает ASG в `POST /api/sync/adspyglass`:
1. `group_by=website` за день → строка на сайт.
2. `group_by=ad_type` за день — **глобально, не по сайту**, результат нигде не сохраняется.
3. На каждый сайт `group_by=spot&website_id=…` → `DailySpotStat`, `adType = "unknown"`.

Прокси-роуты `/api/asg/report`, `/api/asg/websites`, `/api/asg/website/[id]` — прямые обёртки над тем же клиентом.

### 1.2 Google Sheets — `src/lib/google-sheets.ts`, `POST /api/costs/sync`
Сервисный аккаунт (`GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`), read-only. Колонки листа настраиваются (`GoogleSheetConfig`), расход пишется в `CostDaily` на уровне **сайт × день, без гео**. Парсер дат (ISO, `DD.MM.YYYY`, серийные номера Sheets) стоит переиспользовать.

### 1.3 OpenClaw — `POST /api/analysis/run`
`POST ${OPENCLAW_API_URL}/analyze`, Bearer. В TubeStat не переносим: эту роль берёт MCP + Claude.

### 1.4 Чего в adkai нет
- **Яндекс Метрики нет совсем.** Трафик = `hits` из ASG.
- **Расписания нет.** `node-cron` в зависимостях, но нигде не подключён — синк только ручным POST.
- **Авторизация выключена** (`src/middleware.ts` — всё закомментировано).
- **Нет сеток (network), гео × девайса, own deals.**

### 1.5 Проблемы adkai, которые не тащим
- Синк пропускает дату, если она уже `completed` → **рестейт невозможен**, противоречит принципу T-4.
- N+1: на каждую строку `findUnique` + `upsert`; на 40 сайтах × 200 стран это станет десятками тысяч запросов. В новом ингесте — батч-`INSERT … ON CONFLICT` через `createMany`/raw SQL.
- Метрики (profit, romi, health) денормализованы в таблицы → при правке расхода приходится пересчитывать всё руками. В TubeStat только факты + вьюхи.
- `Dockerfile` ожидает `.next/standalone` и `public/`, но в `next.config.ts` нет `output: "standalone"`, а папки `public` нет — сборка образа упадёт.
- `Site.bundleId` один → сайт не может входить в несколько бандлов.

---

## 2. Расхождения спецификации с реальным API — решить до кода

Это главный риск. Спецификация писалась под «идеальный» ASG API, а в adkai видно другое.

| # | Вопрос | Почему важно | Что делаем, если ответ «нет» |
| --- | --- | --- | --- |
| A1 | Принимает ли `group_by` несколько измерений (`website,country,device`)? | Без этого нет грануляции сайт × гео × девайс | На каждый сайт: `website_id=X&group_by=country` и отдельно `group_by=device`. Кросс гео × девайс теряем, пишем `device = UNKNOWN` в гео-разрезе, девайсы — отдельным разрезом с `countryCode = 'ZZ'` |
| A2 | Как называется разрез по партнёрам-сеткам (`broker`? `network`?) и можно ли его скрестить с гео? | На нём держатся `v_network_geo`, алерт «инверсия waterfall», рекомендация флора, `get_network_matrix` | Статистика по партнёрам в ADOK есть, а поля `broker_income` / `broker_hits` в ответе намекают, что партнёр в терминах API — `broker`. Имя параметра подбирает `scripts/asg-probe.sh`. Если скрестить с гео нельзя — итерируем по фильтру `country` или `website_id` |
| A3 | Отдаёт ли `spot`-разрез формат зоны? | `Zone.format` обязателен | Фильтр `ad_type` + `website_id` на каждый формат, или маппинг формата по имени зоны (`Banners_*` → BANNER) с ручной правкой в настройках |
| A4 | Как в API видны own deals? | Принцип №1 спецификации | Если не видны — `FactFixDeal` только из ручного ввода `Deal` |
| A5 | Банер-вью: только `banner_view_rate` или абсолютное число? | `views`, viewable CPM, алерт «невидимая зона» | `views = round(impressions × banner_view_rate)` |
| A6 | В каком часовом поясе ASG режет сутки? А Метрика (TZ счётчика)? | Иначе выручка и трафик за день не сойдутся | Зафиксировать одну TZ в `Site`, запрашивать обе системы в ней |
| A7 | Лимиты ASG API | ADOK блокирует частые запросы (подтверждено: после ~15 запросов подряд сбрасывает соединения). 40 сайтов × 3 разреза × 5 дней каждый час — это сотни запросов | Правила в [08-backend → Лимиты AdSpyglass](./architecture/08-backend.md#asg-limits): один запрос за раз, пауза, дневной бюджет, автостоп на 302/429 |

**Шаг 0 плана — это спайк на полчаса:** запустить `scripts/asg-probe.sh` (перебирает кандидаты `group_by` для партнёров, мульти-группировку и фильтры, ответы кладёт в `docs/asg-samples/`), закрыть A1–A7.

Запуск — вручную из GitHub Actions: workflow **ASG API probe** (Actions → ASG API probe → Run workflow, опционально дата и `website_id`) или пушем изменения в `.github/asg-probe.request` (строки `DATE=YYYY-MM-DD`, `WEBSITE_ID=123`) — так запускает автоматизация без права на `workflow_dispatch`. Нужны секреты `ASG_AUTH_EMAIL` и `ASG_AUTH_TOKEN` в environment `production`. ADOK блокирует частые запросы, поэтому проверка идёт **из одного места** — по умолчанию с прод-сервера по SSH (`WHERE=server`), с раннера GitHub только по `WHERE=github`. Не больше 12 запросов за прогон с паузой 5 с, после первого отказа авторизации (302/401/403), 429 или обрыва соединения прогон останавливается (exit 3). Между прогонами — пауза не меньше часа. Репозиторий публичный, поэтому в логе только структура: коды ответов, число строк, названия полей и маска имён (`999999. aaaa-aaaa.aaa`), без доменов и денег — это проверяет `tests/ci/asg-probe.test.sh`.

Локально или на сервере — с полным выводом:

```bash
ASG_AUTH_EMAIL=... ASG_AUTH_TOKEN=... ./scripts/asg-probe.sh 2026-09-22 137648
```

### Метрика — поправки к спецификации
- Смешивания таблиц можно избежать: `ym:s:pageviews` есть в таблице визитов. Один запрос `ym:s:users, ym:s:visits, ym:s:pageviews, ym:s:bounceRate, ym:s:pageDepth` по `ym:s:date, ym:s:regionCountry, ym:s:deviceCategory` — без склейки двух.
- Обязательно `accuracy=full` (иначе сэмплирование) и `limit=100000`.
- `regionCountry` в ответе обычно несёт `iso_name` — проверить; если есть, `CountryAlias` для Метрики почти не нужен.
- `ym:s:users` неаддитивен по дням: сумма дневных уников за 30 дней > уников за 30 дней. Для RPM это приемлемо (и так делают все), но в UI подписать «сумма дневных уников».
- Токен: OAuth-приложение Яндекса, scope `metrika:read`, один токен на все счётчики, доступ у аккаунта ко всем 40 счётчикам.

### Расход
Спецификация: `CostRate` + CSV. У тебя сейчас расход живёт в Google Sheets. Предлагаю оставить Sheets как третий путь ввода (код уже есть) — строки из Sheets имеют приоритет «импортированное», как CSV. Но гео в листе должно появиться, иначе ROMI по гео не посчитать.

---

## 3. Архитектура развертывания

```
Timeweb Cloud VPS (Ubuntu 24.04)
└── docker compose (/opt/tubestat, deploy/docker-compose.yml)
    ├── caddy             HTTPS (Let's Encrypt) → web:3000              → stats.<домен>
    ├── web               Next.js, UI + /api/* + /api/mcp
    ├── worker            тот же образ, CMD = node dist/worker.js (BullMQ)
    ├── postgres-16       внутренняя сеть, без внешнего порта
    └── redis-7           внутренняя сеть, AOF on
GitHub Actions: PR → проверки; merge в main → образ в GHCR → SSH → deploy.sh (см. CICD.md)
Объектное хранилище S3 (Timeweb S3 или Cloudflare R2) — сырые ответы API + бэкапы
```

Решения:
- **Один репозиторий, один Dockerfile, два сервиса** в compose. Воркер отдельным процессом — чтобы деплой UI не убивал идущий бэкфилл и наоборот.
- **Миграции** — `prisma migrate deploy` в `deploy/deploy.sh` перед рестартом, после бэкапа БД.
- **Вьюхи и роль `mcp_reader`** — в SQL-миграциях Prisma (`prisma migrate dev --create-only`, дописать SQL руками), чтобы они жили в истории.
- **Сырьё в S3.** Если оплата Cloudflare с твоей карты проблемна — Timeweb S3 совместим, тот же `@aws-sdk/client-s3`, меняется только endpoint. Переменные называем `S3_*`, а не `R2_*`.
- **Next.js:** в adkai уже Next 16 — берём его, чтобы переносить компоненты без правок. В 16 `middleware.ts` переименован в `proxy.ts`, учесть при парольной защите.

### Какой сервер брать на Timeweb

| | Минимум | Рекомендую |
| --- | --- | --- |
| CPU | 2 vCPU | **4 vCPU** |
| RAM | 4 GB | **8 GB** |
| Диск | 50 GB NVMe | **80 GB NVMe** |
| ОС | Ubuntu 24.04 LTS | Ubuntu 24.04 LTS |

Образ собирается в GitHub Actions, а не на сервере, поэтому 4 GB хватит на старте; 8 GB — запас под Postgres на большом бэкфилле.

При покупке:
- **Локация.** Метрика доступна откуда угодно; важно, чтобы ASG API (`api.adok.ai`) и Cloudflare R2 отвечали без проблем — европейская локация Timeweb (Амстердам/Франкфурт) безопаснее, чем РФ. Проверить `curl` к обоим сразу после покупки.
- **Публичный IPv4** обязателен (Let's Encrypt, коннектор Claude).
- **SSH-ключ** добавить при создании, вход по паролю потом отключить.
- **Бэкапы диска** Timeweb — включить, это дешёвая страховка поверх бэкапов Postgres.
- Firewall: 22, 80, 443 — настраивает `scripts/server-bootstrap.sh`.

---

## 4. Пошаговый план

### Этап 0 — сервер и спайк API (~1 ч, параллельно)
**Сервер:**
1. Купить VPS (см. выше), привязать A-запись `stats.<домен>` на IP.
2. Запустить `scripts/server-bootstrap.sh`, заполнить `/opt/tubestat/.env`, завести секреты в GitHub — пошагово в [`CICD.md`](./CICD.md).
3. Включить защиту `main` (обязательный check).
4. Создать ресурсы Postgres 16 и Redis 7, S3-хранилище для бэкапов, расписание бэкапа (ежедневно, хранить 14).
5. `curl` с сервера к `api.adok.ai` и `api-metrika.yandex.net` — убедиться, что не режется.

**Спайк API:** закрыть вопросы A1–A7 из раздела 2, образцы ответов → `docs/asg-samples/`. От результата зависит схема `FactRevenue`, поэтому до этого шага миграцию не делаем.

### Этап 1 — фундамент (~1 ч)
- Скелет Next.js 16 + Tailwind 4 + shadcn/ui (переносим `src/components/ui/*` из adkai), Prisma.
- `next.config.ts`: `output: "standalone"`; создать `public/`.
- Схема из спецификации с поправками по итогам спайка; `BundleSite` вместо `Site.bundleId`.
- SQL-миграция: 5 вьюх + роль `mcp_reader`.
- Сид: 40 сайтов (реальные домены + `adsgSiteId` + `metrikaId` — нужен список), бандлы, страны с тирами, `CountryAlias`, сетки с цветами.
- Dockerfile (исправленный), `.env.example`, первый деплой пустого приложения (с `/api/health`) через CI — проверить, что пайплайн работает, **до** написания логики.

### Этап 2 — ингест (~1.5 ч)
- `lib/asg.ts`: клиент на основе adkai (GET, X-Asg-заголовки), ретраи с backoff, запись сырья в S3 до трансформации.
- `lib/metrika.ts`: Stat API, пачки по 5 счётчиков.
- Нормализация стран/девайсов, `XX` для неизвестных + учёт в «нераспознанных».
- Запись батчами через `INSERT … ON CONFLICT DO UPDATE` — без проверки «уже синкали».
- BullMQ: очередь `ingest`, repeatable-джобы по таблице из спецификации, `IngestRun` на каждый прогон, `limiter` под лимиты ASG.
- `worker.ts` — отдельная точка входа, собирается `tsup`/`esbuild` в `dist/worker.js`.
- Бэкфилл 30 дней ручной командой. **Сверка с кабинетом ASG за 3 случайных дня (±2%)** — только после этого дальше.

### Этап 3 — метрики, алерты, MCP (~1 ч)
- Ночные джобы: `CostRate → FactCost`, `Deal → FactFixDeal`, 6 правил алертов → `Alert`.
- Импорт расхода: CSV + (опционально) Google Sheets из adkai.
- `/api/mcp` (streamable HTTP, `@modelcontextprotocol/sdk`): `query` через отдельный пул под `mcp_reader`, + 4 формованных тула. Bearer-токен `MCP_TOKEN`.
- **Контрольная точка:** подключить коннектор в Claude и спросить про убыточные гео JAV-бандла.

### Этап 4 — интерфейс (~1.5 ч)
- Токены из спецификации в `globals.css`, `DataTable` с `ColumnKind`, `KpiCard` (есть заготовка в adkai), `TrendChart`, `PeriodPicker` на `searchParams`.
- Страницы бандла и сайта, затем `/`, `/geo`, `/alerts`.

### Этап 5 — настройки и прод (~1 ч)
- 5 страниц настроек, включая лог `IngestRun` и ручной перезапуск.
- Парольная защита (`proxy.ts`, cookie после ввода `APP_PASSWORD`); `/api/mcp` исключён — у него свой Bearer.
- Домен `stats.<домен>`, HTTPS, подключение MCP в Claude как кастомного коннектора.
- Прогон чеклиста готовности из спецификации.

---

## 5. Переменные окружения

```bash
# База и очередь (внутренние хосты compose)
DATABASE_URL=postgresql://tubestat:***@postgres:5432/tubestat
DATABASE_URL_MCP=postgresql://mcp_reader:***@postgres:5432/tubestat
REDIS_URL=redis://redis:6379

# AdSpyGlass — те же, что в adkai
ASG_API_URL=https://api.adok.ai/api
ASG_AUTH_EMAIL=
ASG_AUTH_TOKEN=

# Яндекс Метрика
METRIKA_TOKEN=

# Сырьё (Timeweb S3 или R2)
S3_ENDPOINT=
S3_BUCKET=tubestat-raw
S3_ACCESS_KEY=
S3_SECRET_KEY=

# Доступ
APP_PASSWORD=
MCP_TOKEN=

# Опционально — импорт расхода из Google Sheets
GOOGLE_SERVICE_ACCOUNT_EMAIL=
GOOGLE_PRIVATE_KEY=
```

---

## 6. Что переносим из adkai, а что пишем заново

| Переносим | Пишем заново |
| --- | --- |
| Клиент ASG (транспорт, заголовки, парсеры имён) | Логика синка (батчи, рестейт, S3, `IngestRun`) |
| `src/components/ui/*` (shadcn), `kpi-card` как основа | Схема данных и вьюхи |
| `google-sheets.ts` (парсер дат, чтение листа) | Метрика, BullMQ, MCP |
| `period-filter` как основа `PeriodPicker` | Health score не переносим — его заменяют алерты |

---

## 7. Что нужно от тебя

1. **Сервер подготовлен по [`CICD.md`](./CICD.md)** и секреты в GitHub заведены.
2. **Домен** для `stats.`.
3. **Документация ASG API** или хотя бы подтверждение, есть ли `group_by` по сеткам и мульти-`group_by`; ещё лучше — выгрузка отчёта «по сеткам» из кабинета, чтобы понять, откуда берётся разрез.
4. **Токен Метрики** и список: домен → AdSpyGlass ID → ID счётчика по всем ~40 сайтам.
5. **Где живёт расход сейчас**: только Google Sheets? есть ли там гео?
6. Какое S3 используем: Cloudflare R2 или Timeweb S3.
