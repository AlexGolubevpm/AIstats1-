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
    queries/                 чтение для страниц: common, reports, finance, deals, month-report, forecast, recommendations, inventory
    actions/                 server actions: auth, alerts, deals, finance, settings; result.ts — общий формат ответа
    services/                операции над базой: costs, deals, finance (выплаты ASG), settings
    domain/                  чистая логика без базы: deals, costs, alerts/rules, inventory, recommendations, errors (RuleError); src/lib/forecast.ts — прогноз месяца
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
| `FactRevenueNetwork` | новая: дата × сайт × сетка (разрез `adnetwork_squashed`, без страны — ADOK не отдаёт сетку × страну) | Сравнение сеток и флор по сайту; в `v_network_geo` строки с `country_code = 'ZZ'` заменяют общий `asg_all` за тот же сайт-день |
| `Placement`, `SitePlacement`, `DealPlace` | новые: каталог мест на сайтах — места по умолчанию плюс все названия зон AdSpyglass (`matchZonesToPlacements` при ингесте зон, ночью и при старте воркера, [ADR 0010](../adr/0010-placements-from-zones.md)); ручное состояние места на сайте (`PlacementUse`: ROTATION, OWN_DEAL, FIX, CPA, FREE, NONE) и сетка, которая его выкупает (`networkId`); места дила — пары сайт × место (`DealPlace`, несколько дилов на ячейку допустимы; [ADR 0009](../adr/0009-deal-places.md)); `Zone.placementSlug` | Вкладка «Форматы» (`/inventory`): выручка места на сайте за период (зоны с этим `placementSlug` + прямые фикс-дилы), чем занято, что свободно. `Zone.placementSlug` ставится по названию зоны при создании и ночным `derive` (только если пустой) или вручную в панели зон; автоматически никогда не перетирается |
| `FactTrafficSource` | новая: дата × сайт × источник трафика (разрез `traffic_source`): загрузки, показы, клики, сумма, которую ADOK называет выручкой (= сколько заплачено источнику) | Вкладка «Источники» сайта; база расхода по ревшаре ([ADR 0006](../adr/0006-traffic-source-cost-revshare.md)) |
| `CostSource` | + `revShare` (доля этой суммы, идущая в расход; Direct — 0), + `asgName` (имя в ADOK) | Расход = сумма ADOK × `revShare`; ставки `CostRate` к источникам из ADOK не применяются |
| `FactCost` | + `origin = ASG`, `rateModel = REVSHARE`; страна `ZZ` (разреза источник × страна в ADOK нет) | Маржа и ROMI по сайту и бандлу; по странам расход источников не раскладывается |
| `FactRevenueDevice` | новая: дата × сайт × устройство (разрез `device`) | Вкладка «Девайсы» сайта; в `FactRevenueGeo` устройство у реальных данных `UNKNOWN` |
| `OpexEntry` | новая: `month` (1-е число), `title`, `category: HOSTING \| SALARY \| SOFTWARE \| CONTENT \| MARKETING \| OTHER`, `amount`, `siteId?`, `note` | Операционные расходы месяца; вьюха `v_opex_daily` делит сумму поровну на дни месяца ([ADR 0007](../adr/0007-opex-and-calendar-months.md)). В `v_site_geo_daily` не входит |
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

**`v_site_geo_daily` — один `UNION ALL` + `GROUP BY`, не CTE с `JOIN`.** Эскиз из спецификации (CTE `rev`/`deal`/`tr`/`cost`, каждая упомянута дважды — в списке ключей и в `LEFT JOIN`) Postgres материализует: фильтр по сайту и датам не доходит до таблиц фактов, и страница сайта за 30 дней рендерилась ~1,4 с. Текущая форма (миграция `20260928160000_site_geo_view_pushdown`) даёт те же колонки и значения, а фильтр по `date`, `site_id`, `country_code` уходит в каждую ветку. Интеграционный тест проверяет план (`EXPLAIN` без `CTE Scan`), E2E — рендер страницы сайта < 1 с.

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

При старте воркер сеет справочники и делает **догон** (лог `startup catch-up`): прогноз всех фикс-дилов за 92 дня (`forecastDeals`; то же — кнопка «Пересчитать прогноз» на `/deals`), расход по ревшаре источников за 62 дня по текущим долям (`revshareCosts`) и переоценку алертов (`evaluateAlerts`). Так каждый деплой применяет новые правила и миграции сразу, а не в 04:45 следующего дня. Затем **догон после простоя** (`planCatchUp`, лог `catch-up backfill queued`): дни текущего месяца по вчерашний, у которых нет разбивки по странам (только `ZZ` или ничего), становятся бэкфиллом «все разрезы» и ставятся в очередь `asg` сразу, не дожидаясь получасового тика; если бэкфилл уже идёт, его не трогаем. Выплаты AdSpyglass (`AsgPayout`) заново раскладываются по строкам месяца после каждой записи гео-строк (`reapplyPayouts`), иначе переингест дня обнулял бы `revenueConfirmed`.

| Джоб | Очередь | Расписание (UTC) | Окно | Что делает |
| --- | --- | --- | --- | --- |
| `asg:totals` | `asg` | каждый час, :05 | вчера + сегодня | Один запрос `group_by=website` на день окна → итоги по сайтам (`FactRevenueGeo`, страна `ZZ`) |
| `asg:sites` | `asg` | 04:00 | T-`ASG_RESTATE_DAYS`…T-1 | В день: `group_by=website` (итоги для сверки) и `group_by=spot` по аккаунту (зона → сайт по домену в названии). По каждому сайту с `platforms_ids[]=<id>`: `group_by=country`, `adnetwork_squashed`, `device`, `traffic_source` → `FactRevenueGeo`, `FactRevenueNetwork`, `FactRevenueDevice`, `FactTrafficSource`, затем расход по ревшаре источников (`revshareCosts` → `FactCost`, `origin = ASG`). Сайт × день = 4 запроса (27 сайтов × 2 дня ≈ 220 в ночь + 48 почасовых — в бюджете 800 с запасом ≈ 500 на бэкфилл). Выручка по странам сверяется с итогом сайта из `group_by=website`: расхождение больше 2% (и больше $0.05) пишется в `IngestRun.error`, прогон — `partial` |
| `asg:backfill` | `asg` | каждые 30 минут; без заданного окна — пропуск без запросов | окно задаётся блоком «Бэкфилл AdSpyglass» на «Интеграциях» (по умолчанию: все разрезы — с 1-го числа текущего месяца, только итоги — с 1-го числа прошлого; по T-3) | Два режима. **Все разрезы** — то же, что `asg:sites` (2 + 4 × сайтов запросов на день); **только итоги по сайтам** — один `group_by=website` на день (строки `ZZ`, дни с готовой разбивкой по странам не трогаются) — хватает для графиков, прогноза и сравнения месяцев. По одному дню от новых к старым и только пока `использовано + запросов_на_день ≤ ASG_DAILY_BUDGET − ASG_BACKFILL_RESERVE`; счётчик обнуляется в полночь UTC, так что длинное окно само растягивается на несколько суток. Состояние (`pending/done/failed`) — `AppSetting asg_backfill`; каждая порция с запросами — свой `IngestRun`. Когда последний день загружен — `derive` за всё окно |
| `metrika` | `main` | каждый час, :15 | вчера + сегодня | → `FactTraffic` |
| `derive` | `main` | 04:45 | T-4…T-1 | Расход по ставкам → прогноз дилов (флэт «в месяц» — по дням календарного месяца) → алерты, строго по порядку |
| `geo:reprocess` | `main` | по кнопке | 90 дней | Переписывает строки стран и устройств из сохранённого сырья (после сопоставления страны или чтобы заново разложить выручку сеток по итогу сайта), затем `derive`. Запросов к API нет |

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
| Дневной бюджет | `ASG_DAILY_BUDGET`, по умолчанию 800 запросов (интервал 5 с → ≈ 67 минут запросов в сутки; блокировка ADOK — про частоту, не про суточное число); бэкфилл оставляет `ASG_BACKFILL_RESERVE` (300) ночному прогону; при исчерпании джобы откладываются до следующих суток, `IngestRun.status = partial`. Ночной `asg:sites` тратит ~4 запроса на сайт на день (страны, сетки, устройства, источники трафика) + 2 на день; на 27 сайтов за 2 дня это ≈ 220, плюс почасовые итоги — поэтому 300 не хватало |
| Автостоп | 302 на `/users/sign_in`, 401, 403, 429 или обрыв соединения → очередь `asg` ставится на паузу на 60 мин, алерт №9, без ретраев |
| Ретраи | Только 5xx и таймауты: 2 попытки, пауза 1 и 5 мин |

Чтобы уложиться в бюджет, ингест строится от запросов по **всему аккаунту**, а не по каждому сайту:

- Ежечасно — только разрезы по всему аккаунту за сегодня и вчера (`group_by=website`, партнёры, гео — если API отдаёт их сразу по всем сайтам). Это единицы запросов в час, а не сотни.
- Разрезы, которые требуют `website_id` (зоны, иногда гео по сайту), — только в ночном бэкфилле и только за T-1…T-4, растянутые по времени лимитером.
- Сайты со статусом `PAUSED`/`ARCHIVED` не запрашиваются.
- Уже закрытые дни (старше T-4) не перезапрашиваются никогда — пересчёт идёт из сырья в S3.
- Каждый запрос учитывается в `IngestRun.requests`; на `/settings/integrations` виден расход бюджета за сутки.

### Что известно об API ADOK (проверено с сервера, 2026-09-25…28)

| Запрос | Результат |
| --- | --- |
| `group_by=website` | 200, строка на сайт: `"137648. domain.com"` |
| `group_by=country` | 200, строка на страну, есть поле `iso` (маппинг берёт его первым) |
| `group_by=spot` | 200, строка на зону: `"491410. Name (domain.com)"` — домен даёт сайт |
| `group_by=adnetwork_squashed` | 200, строка на сетку (в UI — «Demand»), имя вида `AdPulsar.io` → слаг `adpulsar` |
| `group_by=date`, `device`, `ad_type`, `platform`, `adnetwork_type`, `campaign` | 200 |
| `group_by=traffic_source` | 200, строка на источник трафика (Direct, TubeCrown, …), с `platforms_ids[]` — по сайту. Поле `broker_income` у источника ADOK называет выручкой; по словам владельца это сколько заплачено источнику — берётся расходом. Сумма по источникам = выручка сайта (1.000×) ([ADR 0006](../adr/0006-traffic-source-cost-revshare.md)). Полей стоимости нет |
| `group_by=broker|network|partner|demand|adnetwork` | 422 |
| Два измерения (`website,country`, `group_by[]`, повтор параметра) | 422 или только одно измерение |
| Фильтр по сайту `platforms_ids[]=<id>` | **работает** (ответ = 1.00× итога сайта) для стран, сеток и зон |
| `website_id`, `website_ids[]`, `websites`, `site_id`, `filter[…]` и др. — 16 вариантов | игнорируются молча: ответ = весь аккаунт |

**Выручка сеток в посайтовых разрезах (проверено 2026-10-02 на данных за 01.10).** С `platforms_ids[]` ADOK фильтрует по сайту только «свои» поля: `hits`, `impressions`, `clicks`, `predicted_income` — их сумма по разрезу = итогу сайта (1.000×). Поля стороны сеток (`broker_income`, `broker_hits`) по сайту не фильтруются: в разрезе по странам сумма `broker_income` от 1× до 100× итога сайта (по сети 2.58×), в разрезе по устройствам — медиана 0.07×. В разрезе `adnetwork_squashed` они сходятся с итогом сайта (1.000×). Поэтому:

- выручка сайта (`broker_income`) и показы сеток (`broker_hits`) берутся из `group_by=website` — это источник истины;
- в разрезах по странам и устройствам они раскладываются по ячейкам пропорционально `predicted_income` (если его нет — показам, потом загрузкам), сумма ровно равна итогу сайта (`allocateBroker`, `apportion` в `map.ts`);
- сверка ±2% сравнивает `predicted_income` разреза по странам с итогом сайта — это проверка, что фильтр по сайту сработал;
- ответ `group_by=website` пишется в сырьё и в ночной джобе: по нему `geo:reprocess` пересчитывает старые дни без запросов к API.

Итог по сети в дашборде — сумма сайтов из `group_by=website`. Аккаунтный разрез по сеткам (`group_by=adnetwork_squashed` без фильтра) на ~7% больше: это выручка, не привязанная ни к одному сайту. `group_by=date` подтверждает, что `from`/`to` соблюдаются (и `period=YYYY-MM-DD - YYYY-MM-DD` из веб-интерфейса тоже). Диагностика: `MODE=dates` и `MODE=recon` в `.github/asg-probe.request` — печатают только даты, количества и отношения, без сумм.

Имя фильтра взято из запроса веб-интерфейса ADOK (`args.platforms_ids`): сайты там называются «платформами». Защита остаётся: каждый посайтовый ответ сверяется с итогом сайта из `group_by=website`; если ответ больше сайта (> 105%), он отбрасывается, причина пишется в `AppSetting` (`asg_site_filter_ignored:platforms_ids`), посайтовые разрезы пропускаются 7 дней. Проверка API — `.github/asg-probe.request` с `MODE=discover|filters|multi|dates|recon`.

Точные значения интервала и бюджета уточняются у ADOK или подбираются по результатам первой недели; до этого — консервативные значения выше.

## UX бэкенда: ошибки и данные, которые видит человек

- Любая ошибка ингеста видна в трёх местах: индикатор свежести в сайдбаре, лог на `/settings/integrations`, алерт №9. Пустой график с «Ингест не отработал» показывает время последнего успешного прогона и кнопку перезапуска.
- Неизвестная страна не роняет джоб: строка пишется с `XX` и попадает в «Нераспознанные гео».
- Неизвестная сетка создаётся автоматически с цветом «Прочее».
- Неизвестный сайт из AdSpyglass не пишется в факты, но появляется в «Подтянуть сайты» на `/settings/sites`.
- Сообщения об ошибках — по-русски, с объектом и действием: «Сайт japan-whores.com: AdSpyglass вернул 401. Проверьте ASG_AUTH_TOKEN на сервере».

## Авторизация и безопасность

- Один пользователь: логин `APP_LOGIN` (по умолчанию `Admin`, сравнивается без учёта регистра), пароль — bcrypt-хеш в базе (первый вход берёт `APP_PASSWORD` из env; `Sync server .env` с секретом `APP_PASSWORD` сбрасывает хеш и сессии), httpOnly + SameSite=Lax cookie сессии на 30 дней (`Secure` при `COOKIE_SECURE=1`), 5 неудачных попыток с IP → блокировка на 15 минут.
- `proxy.ts` (Next 16) закрывает всё, кроме `/login`, `/api/health`, `/api/mcp`.
- MCP — отдельный Bearer-токен (хеш в базе) и отдельная роль Postgres без доступа к таблицам.
- Секреты интеграций — только в `.env` на сервере, в базу не пишутся.

## Наблюдаемость

- Логи — JSON-строки в stdout, `docker compose logs worker`. Строка джоба несёт `jobId`, `job` и результат; вызов MCP — инструмент, параметры, время, число строк.
- `/api/health` возвращает статус и версию (SHA коммита).
- Бэкап Postgres — перед каждым деплоем (`deploy.sh`, последние 10) и ежедневно в 03:30 UTC (`deploy/backup.sh` по cron, последние 14) в `/opt/tubestat/backups`. Выгрузка в S3 — когда будет заведено хранилище.

## Переменные окружения

Шаблон — [`.env.example`](../../.env.example).

| Переменная | Кто читает | Назначение |
| --- | --- | --- |
| `DATABASE_URL`, `REDIS_URL` | web, worker | Задаются в compose |
| `APP_LOGIN` | web | Логин (по умолчанию `Admin`) |
| `APP_PASSWORD` | web | Пароль до первой смены в UI |
| `COOKIE_SECURE` | web | `1` — cookie сессии только по HTTPS |
| `APP_URL` | web | Абсолютные ссылки в ответах MCP |
| `MCP_TOKEN` | web | Запасной MCP-токен; основной выпускается в UI |
| `ASG_AUTH_EMAIL`, `ASG_AUTH_TOKEN`, `ASG_API_URL` | worker, web (проверки) | AdSpyglass |
| `ASG_MIN_INTERVAL_MS`, `ASG_DAILY_BUDGET`, `ASG_RESTATE_DAYS`, `ASG_BACKFILL_RESERVE` | worker, web | Лимиты AdSpyglass и резерв бэкфилла |
| `METRIKA_TOKEN` | worker, web (проверки) | Яндекс Метрика |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | worker | Сырьё в S3; без них — `RAW_DIR` (том `raw_data`) |
| `COMPOSE_PROFILES=worker` | compose | Включает воркер |
