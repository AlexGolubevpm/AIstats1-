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

- **web** отдаёт UI и API и не ходит во внешние API из запросов пользователя. Исключения — «Проверить» в настройках сайта и «Проверить соединение»; оба с таймаутом 10 секунд.
- **worker** — единственный процесс, который пишет факты. Перезапуск web не прерывает бэкфилл.
- Один образ Docker, разные команды запуска (`node server.js` / `node dist/worker.js`).

## Структура кода

```
src/
  app/                       страницы и route handlers (Next.js App Router)
    (app)/…                  защищённые страницы
    api/health/route.ts
    api/mcp/route.ts
    api/export/[table]/route.ts
  server/                    только серверный код, не импортируется в клиентские компоненты
    db.ts                    Prisma client
    queries/                 чтение для страниц: одна функция — один блок страницы
    actions/                 server actions: мутации из UI, валидация zod
    ingest/
      adspyglass/            клиент, маппинг, запись
      metrika/
      normalize.ts           страны, девайсы, форматы
      raw-store.ts           S3
    jobs/                    определения BullMQ-джобов и расписаний
    domain/
      deals.ts               раскладка сумм дилов по дням, статусы
      costs.ts               выбор ставки, расчёт расхода
      alerts/                правила алертов (SQL + обёртка)
    mcp/                     инструменты MCP
  lib/
    metrics.ts               формулы (общие для UI и сервера)
    format.ts
    period.ts                пресеты и сравнение периодов
  worker.ts                  точка входа воркера
prisma/
  schema.prisma
  migrations/                включая SQL для вьюх и роли mcp_reader
tests/                       см. 10-testing
```

Правило слоёв: `app` → `server/queries|actions` → `server/domain` → `db`. Доменная логика не знает о Next.js и тестируется без него.

## Модель данных

Основа — схема из [спецификации](../tubestat-spec.md#модель-данных): справочники `Site`, `Bundle`, `BundleSite`, `Country`, `CountryAlias`, `Zone`, `Network`; факты `FactRevenue`, `FactTraffic`, `FactCost`, `FactFixDeal`; служебное `IngestRun`, `CostRate`. Изменения и дополнения:

| Модель | Изменение | Зачем |
| --- | --- | --- |
| `FactCost` | + `origin: RATE \| IMPORT`, + `importBatchId?` | Импорт перекрывает расчёт; откат импорта |
| `FactRevenue` | `revenueConfirmed` заполняется из `AsgPayout` | Подтверждение выплат AdSpyglass |
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
| Server Components + `server/queries` | страницы | Всё чтение для UI. Без клиентского fetch там, где хватает RSC |
| Server Actions + zod | `server/actions` | Все мутации из UI: сайты, бандлы, ставки, дилы, периоды, оплаты, перезапуск ингеста |
| Route handlers | `/api/health` | Healthcheck деплоя |
| | `/api/export/[table]` | CSV текущего среза (те же queries) |
| | `/api/mcp` | MCP, см. [09](./09-mcp.md) |
| | `/api/ingest/[source]/run` | Постановка джоба, закрыт паролем, возвращает id джоба |

Каждый action возвращает `{ ok: true, data } | { ok: false, error: { code, message, fieldErrors? } }`. UI показывает `fieldErrors` у полей, остальное — Toast. Исключения не пробрасываются в клиент.

## Джобы

| Джоб | Расписание (UTC) | Окно | Что делает |
| --- | --- | --- | --- |
| `adspyglass:geo` | каждый час, :05 | вчера + сегодня | Гео-разрез по всему аккаунту → `FactRevenue` (`zoneId = null`) |
| `adspyglass:zones` | 04:00, в составе бэкфилла | T-1…T-4 | Зонный разрез по сайтам → `FactRevenue` (`countryCode = 'ZZ'`); ежечасно не запускается из-за лимитов ADOK |
| `metrika` | каждый час, :15 | вчера + сегодня | → `FactTraffic` |
| `adspyglass:backfill` | 04:00 | T-1…T-4 | Оба разреза, рестейт |
| `metrika:backfill` | 04:30 | T-1…T-4 | Рестейт |
| `costs:calc` | 04:45 | T-1…T-4 | `CostRate` × уники → `FactCost` (`origin = RATE`), импорт не трогает |
| `deals:forecast` | 04:50 | T-1…T-4 | Прогноз по дилам → `FactFixDeal` (`FORECAST`) |
| `alerts:evaluate` | 05:00 | 30 дней | Все правила → `Alert` |
| `deals:distribute` | по событию | период | После ввода периода или оплаты — раскладка по дням |
| `raw:reprocess` | по событию | диапазон | Пересборка фактов из S3 после сопоставления гео |

Общие правила:
- **Идемпотентность.** Запись — `INSERT … ON CONFLICT (натуральный ключ) DO UPDATE`, батчами по 1 000 строк. Повторный прогон за ту же дату перезаписывает, а не дублирует. Никакой проверки «уже синкали» (ошибка adkai).
- **Сырьё раньше базы.** Ответ API → S3 `raw/{source}/{cut}/{date}/{runId}.json` → трансформация → запись. `IngestRun.rawKey` хранит ключ.
- **Ретраи.** 3 попытки с экспоненциальной паузой на 5xx и сетевые ошибки; на 4xx — сразу `failed` с текстом ответа.
- **Лимиты.** AdSpyglass — см. [ниже](#asg-limits); Метрика — не больше 5 параллельных запросов.
- **Статусы `IngestRun`.** `ok` · `partial` (часть сайтов упала, остальные записаны) · `failed`. У partial в `error` список сайтов.
- **Цепочка ночных джобов** идёт по порядку: расход и дилы считаются после рестейта трафика, алерты — после всех.

<a id="asg-limits"></a>
## Лимиты AdSpyglass

ADOK блокирует клиентов за частые запросы (на спайке: после ~15 запросов подряд — `Connection reset by peer`, до этого — редиректы на `/users/sign_in`). Запросов к нему должно быть **мало и по одному**:

| Правило | Значение |
| --- | --- |
| Параллельность | 1 запрос за раз: отдельная очередь `asg`, `concurrency = 1` |
| Пауза между запросами | `ASG_MIN_INTERVAL_MS`, по умолчанию 5 000 мс (`limiter: { max: 1, duration: 5000 }`) |
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

- Пароль приложения: bcrypt-хеш в базе (первый запуск берёт `APP_PASSWORD` из env), httpOnly + Secure + SameSite=Lax cookie сессии на 30 дней, rate limit на `/login`.
- `proxy.ts` (Next 16) закрывает всё, кроме `/login`, `/api/health`, `/api/mcp`.
- MCP — отдельный Bearer-токен (хеш в базе) и отдельная роль Postgres без доступа к таблицам.
- Секреты интеграций — только в `.env` на сервере, в базу не пишутся.

## Наблюдаемость

- Логи — JSON в stdout (`pino`), `docker compose logs`. Каждая строка джоба несёт `jobId`, `source`, `date`.
- `/api/health` проверяет подключение к Postgres и Redis и возвращает версию (SHA коммита).
- Бэкап Postgres — перед каждым деплоем (`deploy.sh`) и ежедневно (cron на сервере → S3), хранение 14 дней.
