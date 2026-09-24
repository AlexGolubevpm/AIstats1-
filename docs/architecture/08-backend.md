# 08. Бэкенд

## Процессы

```
                   ┌──────────────── Timeweb VPS / docker compose ────────────────┐
 браузер ──HTTPS──►│ caddy ──► web (Next.js)                                       │
 Claude  ──HTTPS──►│             ├─ страницы (RSC) ─┐                              │
                   │             ├─ server actions ─┼─► Prisma ──► postgres        │
                   │             ├─ /api/*  ────────┘         ▲                    │
                   │             └─ /api/mcp ──► pg (mcp_reader, только вьюхи)     │
                   │                                          │                    │
                   │           worker (BullMQ) ───────────────┘  ◄──► redis        │
                   │             ├─ ingest: AdSpyglass, Метрика ──► S3 (сырьё)     │
                   │             └─ nightly: расход, дилы, алерты                  │
                   └───────────────────────────────────────────────────────────────┘
```

- **web** отдаёт UI и API и не ходит во внешние API из запросов пользователя. Исключения — «Проверить» у сайта, «Подтянуть сайты» и «Проверить соединение»: по одному запросу, через тот же бюджет и паузу AdSpyglass, без ретраев (`ingest/probe.ts`).
- **worker** — единственный процесс, который ходит в API источников по расписанию. Перезапуск web не прерывает бэкфилл. Исключения, которые пишет web: импорт расхода, выплаты ASG, раскладка периодов дилов, демо-данные.
- Один образ Docker, разные команды запуска (`node server.js` / `node dist/worker.js`).

## Структура кода

```
src/
  app/                       страницы и route handlers (Next.js App Router)
    (app)/…                  защищённые страницы; (app)/layout.tsx проверяет сессию
    login/
    api/health/route.ts      healthcheck деплоя
    api/mcp/route.ts         MCP (streamable HTTP, stateless)
    api/export/month/route.ts  «Отчёт за месяц» (CSV)
  components/
    ui/                      кнопки, карточки, поля, Sheet/Confirm, тосты, тултипы
    data/                    DataTable, форматирование ячеек, графики, KPI, период
    forms/action-form.tsx    форма поверх server action: ошибка у поля, тост
    pages/                   общие для страниц колонки и формы (дил, период, оплата)
  server/                    только серверный код
    db.ts                    Prisma client (создаётся при первом обращении)
    config.ts                переменные окружения
    auth.ts, session.ts      пароль, сессии, MCP-токен
    queries/                 чтение для страниц: common, reports, finance, deals, month-report
    actions/                 server actions: auth, alerts, deals, finance, settings; result.ts — общий формат ответа
    services/                операции над базой: costs, deals, finance (выплаты ASG), settings
    domain/                  чистая логика без базы: deals, costs, alerts/rules, errors (RuleError)
    ingest/
      adspyglass/            клиент с лимитами, маппинг, запись, пересчёт из сырья
      metrika/
      normalize.ts           страны, девайсы, форматы, домены
      raw-store.ts           сырьё: S3 или локальная папка (том raw_data)
      probe.ts               интерактивные проверки из настроек (с теми же лимитами)
      run.ts                 IngestRun, пауза и дневной бюджет AdSpyglass
    jobs/                    обработчики и расписания BullMQ
    mcp/                     sql-guard, инструменты, сервер
    seed/                    справочники, демо-данные
  lib/                       metrics, format, period, charts — общие для UI и сервера
  worker.ts                  точка входа воркера (dist/worker.js)
  seed.ts                    справочники при деплое (dist/seed.js)
prisma/
  schema.prisma
  migrations/                включая SQL для вьюх и роли mcp_reader
  data/countries.json
tests/                       см. 10-testing
```

Правило слоёв: `app` → `server/queries|actions` → `server/services` → `server/domain` → `db`. Доменная логика не знает о Next.js и тестируется без него.

## Модель данных

Основа — схема из [спецификации](../tubestat-spec.md#модель-данных): справочники `Site`, `Bundle`, `BundleSite`, `Country`, `CountryAlias`, `Zone`, `Network`; факты `FactRevenue`, `FactTraffic`, `FactCost`, `FactFixDeal`; служебное `IngestRun`, `CostRate`. Изменения и дополнения:

| Модель | Изменение | Зачем |
| --- | --- | --- |
| `FactCost` | + `origin: RATE \| IMPORT`, + `importBatchId?` | Импорт перекрывает расчёт; откат импорта |
| `FactRevenue` → `FactRevenueGeo` + `FactRevenueZone` | Два факта вместо одного с `zoneId = null` / `countryCode = 'ZZ'`, см. [ADR 0004](../adr/0004-revenue-facts-and-billing.md) | Разрезы AdSpyglass не складываются друг с другом |
| `FactRevenueGeo` | `revenueConfirmed` заполняется выплатой `AsgPayout` пропорционально отчётной выручке | Подтверждение выплат AdSpyglass |
| `Deal` | + `billedVia: DIRECT \| VIA_ASG` | Дил через AdSpyglass уже внутри `own_deals` и не добавляется второй раз |
| `IngestRun` | + `requests Int` | Учёт дневного бюджета запросов к AdSpyglass |
| `Deal` | + `advertiserId`, `paymentBasis`, `billingPeriod`, `paymentTermsDays`, `counterSource: ASG_ZONE \| METRIKA \| MANUAL`, `status`, `notes` | Модель сделки из [04](../product/04-finance-and-deals.md#deals) |
| `DealSite` | новая: `dealId`, `siteId`, `zoneId?` | Дил на нескольких сайтах и зонах |
| `Advertiser` | новая: `name`, `contact` | Справочник для автодополнения и группировки дебиторки |
| `DealPeriod` | новая: `dealId`, `siteId?`, `countryCode?`, `from`, `to`, `impsReported`, `amountCalculated`, `amountInvoiced`, `overrideReason?`, `invoiceNo`, `dueAt`, `amountPaid?`, `paidAt?`, `status: OPEN \| INVOICED \| PAID \| PARTIAL \| DISPUTED \| WRITTEN_OFF`, `version`, `supersededById?` | Цифры рекламодателя и оплаты |
| `FactFixDeal` | `isConfirmed` → `revenueState: FORECAST \| INVOICED \| CONFIRMED`, + `dealPeriodId?` | Три статуса денег |
| `AsgPayout` | новая: `month`, `amountReported`, `amountReceived`, `receivedAt` | Выплаты AdSpyglass |
| `Alert` | новая: `rule`, `entityKey`, `level`, `payload Json`, `firstSeenAt`, `lastSeenAt`, `snoozedUntil?`, `resolvedAt?` | Алерты с дедупликацией |
| `ImportBatch` | новая: `kind`, `fileName`, `rows`, `total`, `createdAt`, `revertedAt?` | История импортов |
| `AuditLog` | новая: `entity`, `entityId`, `field`, `before`, `after`, `reason`, `at` | История дилов и настроек |
| `Session` | новая: `id`, `createdAt`, `lastSeenAt`, `ip` | Сброс сессий при смене пароля |

Деньги — `Decimal(12,4)`, ставки — `Decimal(10,5)`, в TypeScript — `Prisma.Decimal`, без `number` в расчётах денег. Даты фактов — `@db.Date` в UTC-сутках источника (часовой пояс фиксируется при спайке API, вопрос A6 в плане).

## API

| Тип | Где | Для чего |
| --- | --- | --- |
| Server Components + `server/queries` | страницы | Всё чтение для UI |
| Server Actions | `server/actions` | Все мутации из UI: сайты, бандлы, ставки, импорт расхода, сетки, дилы, периоды, оплаты, выплаты ASG, постановка джобов, пароль, MCP-токен, демо-данные |
| Route handlers | `/api/health` | Healthcheck деплоя |
| | `/api/export/month?month=YYYY-MM` | «Отчёт за месяц»: сайт × источник × статус, расход с минусом |
| | `/api/mcp` | MCP, см. [09](./09-mcp.md) |

CSV текущей таблицы формируется в браузере из тех же данных, что на экране (кнопка CSV у DataTable).

Каждый action возвращает `ActionResult = { ok?, error?, field?, message?, data? }`. Нарушение бизнес-правила — `RuleError(code, message, field)`: UI показывает `error` под полем `field`, остальное — тостом. Прочие исключения логируются и превращаются в `error`; наружу стек не уходит.

## Джобы

| Джоб | Очередь | Расписание (UTC) | Окно | Что делает |
| --- | --- | --- | --- | --- |
| `asg:totals` | `asg` | каждый час, :05 | вчера + сегодня | Один запрос `group_by=website` на день окна → итоги по сайтам (`FactRevenueGeo`, страна `ZZ`) |
| `asg:sites` | `asg` | 04:00 | T-`ASG_RESTATE_DAYS`…T-1 | По каждому активному сайту: гео-разрез и зоны. Сайт × день = 2 запроса |
| `metrika` | `main` | каждый час, :15 | вчера + сегодня | → `FactTraffic` |
| `derive` | `main` | 04:45 | T-4…T-1 | Расход по ставкам → прогноз дилов → алерты, строго по порядку |
| `geo:reprocess` | `main` | по кнопке | 90 дней | Переписывает гео-строки из сохранённого сырья после сопоставления страны, затем `derive`. Запросов к API нет |

Ручной запуск и бэкфилл — на `/settings/integrations` (action ставит джоб в очередь). Для бэкфилла `asg:sites` форма считает число запросов и требует подтверждения, если оно больше дневного бюджета. Раскладка сумм периода по дням (`distributePeriod`) выполняется сразу в action ввода периода или оплаты.

Общие правила:
- **Идемпотентность.** Повторный прогон за ту же дату перезаписывает строки по натуральному ключу, а не дублирует.
- **Сырьё раньше базы.** Ответ API → `raw/{source}/{cut}/{date}/{runId}.json` (S3 или том `raw_data`) → трансформация → запись. По этим ключам работает `geo:reprocess`.
- **Статусы `IngestRun`.** `ok` · `partial` (часть сайтов упала, остальные записаны; список в `error`) · `failed`.
- **Справочники.** `dist/seed.js` при каждом деплое и воркер при старте идемпотентно досоздают страны, алиасы, системные сетки и источники закупки.

<a id="asg-limits"></a>
## Лимиты AdSpyglass

ADOK блокирует клиентов за частые запросы (на спайке: после ~15 запросов подряд — `Connection reset by peer`, до этого — редиректы на `/users/sign_in`). Запросов к нему должно быть **мало и по одному**:

| Правило | Значение |
| --- | --- |
| Параллельность | 1 запрос за раз: отдельная очередь `asg`, `concurrency = 1` |
| Пауза между запросами | `ASG_MIN_INTERVAL_MS`, по умолчанию 5 000 мс; держит сам `AsgClient` (запросы сериализованы), а не только очередь |
| Дневной бюджет | `ASG_DAILY_BUDGET`, по умолчанию 300 запросов; при исчерпании джобы откладываются до следующих суток, `IngestRun.status = partial` |
| Автостоп | 302 на `/users/sign_in`, 401, 403, 429 или обрыв соединения → очередь `asg` ставится на паузу на 60 мин, алерт №9, без ретраев |
| Ретраи | Только 5xx и таймауты: 2 попытки, пауза 1 и 5 мин |

Чтобы уложиться в бюджет, ингест строится от запросов по **всему аккаунту**, а не по каждому сайту:

- Ежечасно — только разрезы по всему аккаунту за сегодня и вчера (`group_by=website`, партнёры, гео — если API отдаёт их сразу по всем сайтам). Это единицы запросов в час, а не сотни.
- Разрезы, которые требуют `website_id` (зоны, иногда гео по сайту), — только в ночном бэкфилле и только за T-1…T-4, растянутые по времени лимитером.
- Сайты со статусом `PAUSED`/`ARCHIVED` не запрашиваются.
- Уже закрытые дни (старше T-4) не перезапрашиваются никогда — пересчёт идёт из сырья в S3.
- Каждый запрос учитывается в `IngestRun.requests`; на `/settings/integrations` виден расход бюджета за сутки.

Точные значения интервала и бюджета уточняются у ADOK или подбираются по результатам первой недели; до этого — консервативные значения выше.

## UX бэкенда: ошибки и данные, которые видит человек

- Любая ошибка ингеста видна в трёх местах: индикатор свежести в сайдбаре, лог на `/settings/integrations`, алерт №9. Пустой график с «Ингест не отработал» показывает время последнего успешного прогона и кнопку перезапуска.
- Неизвестная страна не роняет джоб: строка пишется с `XX` и попадает в «Нераспознанные гео».
- Неизвестная сетка создаётся автоматически с цветом «Прочее».
- Неизвестный сайт из AdSpyglass не пишется в факты, но появляется в «Подтянуть сайты» на `/settings/sites`.
- Сообщения об ошибках — по-русски, с объектом и действием: «Сайт japan-whores.com: AdSpyglass вернул 401. Проверьте ASG_AUTH_TOKEN на сервере».

## Авторизация и безопасность

- Пароль приложения: bcrypt-хеш в базе (первый вход берёт `APP_PASSWORD` из env), httpOnly + SameSite=Lax cookie сессии на 30 дней (`Secure` при `COOKIE_SECURE=1`), 5 неудачных попыток с IP → блокировка на 15 минут.
- `proxy.ts` (Next 16) закрывает всё, кроме `/login`, `/api/health`, `/api/mcp`.
- MCP — отдельный Bearer-токен (хеш в базе) и отдельная роль Postgres без доступа к таблицам.
- Секреты интеграций — только в `.env` на сервере, в базу не пишутся.

## Наблюдаемость

- Логи — JSON-строки в stdout, `docker compose logs worker`. Строка джоба несёт `jobId`, `job` и результат; вызов MCP — инструмент, параметры, время, число строк.
- `/api/health` возвращает статус и версию (SHA коммита).
- Бэкап Postgres — перед каждым деплоем (`deploy.sh`) и ежедневно (cron на сервере → S3), хранение 14 дней.

## Переменные окружения

Шаблон — [`.env.example`](../../.env.example).

| Переменная | Кто читает | Назначение |
| --- | --- | --- |
| `DATABASE_URL`, `REDIS_URL` | web, worker | Задаются в compose |
| `APP_PASSWORD` | web | Пароль до первой смены в UI |
| `COOKIE_SECURE` | web | `1` — cookie сессии только по HTTPS |
| `APP_URL` | web | Абсолютные ссылки в ответах MCP |
| `MCP_TOKEN` | web | Запасной MCP-токен; основной выпускается в UI |
| `ASG_AUTH_EMAIL`, `ASG_AUTH_TOKEN`, `ASG_API_URL` | worker, web (проверки) | AdSpyglass |
| `ASG_MIN_INTERVAL_MS`, `ASG_DAILY_BUDGET`, `ASG_RESTATE_DAYS` | worker, web | Лимиты AdSpyglass |
| `METRIKA_TOKEN` | worker, web (проверки) | Яндекс Метрика |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | worker | Сырьё в S3; без них — `RAW_DIR` (том `raw_data`) |
| `COMPOSE_PROFILES=worker` | compose | Включает воркер |
