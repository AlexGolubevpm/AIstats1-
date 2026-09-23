# TubeStat — аналитика сети: техническая документация

2026-09-22

## Что строим

Внутренний аналитический дашборд по сети из ~40 тьюб-сайтов. Не дашборд выручки, а дашборд маржи: трафик покупается, значит любая цифра дохода без цены закупки того же гео ничего не значит.

**Источники данных:** AdSpyglass API (медиируемая монетизация), Яндекс Метрика API (трафик), ручной ввод закупки (TubeCrown, TubeTraffic/ixxx), ручной ввод фикс-дилов и own deals.

**Что пользователь видит:** сводку по бандлам, страницу бандла, страницу сайта, настройки. Плюс MCP-сервер, через который к тем же данным ходит Claude.

**Стек.** Next.js 15 App Router, Prisma, PostgreSQL, BullMQ + Redis, Tailwind + shadcn/ui, TanStack Table, Recharts. Деплой Coolify. Всё уже знакомое, ничего нового под этот проект не вводим.

### Границы скоупа

Пять часов — это ингест, модель, четыре страницы и MCP. Всё остальное сознательно за бортом первой версии:

- Нет авторизации сложнее одного пароля в middleware. Сервис внутренний.
- Нет real-time. Данные обновляются по расписанию, минимальная гранулярность — сутки.
- Нет автоматического изменения бидов в AdSpyglass. Система только рекомендует, руками ставит человек.
- Нет мультивалютности. Всё в USD.
- Нет исторической миграции. Тянем с даты запуска плюс 30 дней назад одним бэкфиллом.
- Нет почасовых разрезов. Только день.

### Принципы, заложенные с самого начала

Эти четыре пункта стоят десять минут на старте и недели разбирательств потом:

1. **Own deals живут отдельным источником.** AdSpyglass не включает их в форматный и зонный отчёты, только в гео. Держим `fact_fixdeal` отдельно и склеиваем во вьюхе с флагом источника.
2. **Два счётчика показов — обе колонки в таблице.** Свои показы и показы рекламодателя, дискрепанси считает вьюха.
3. **Отчётная выручка ≠ подтверждённая.** Пока платёж не пришёл, это прогноз.
4. **Сырой ответ API складываем в R2 до трансформации.** Пересчёт метрик не должен требовать повторного обхода API.

## Модель данных

Общая грануляция, на которой сходятся все четыре источника — **дата × сайт × страна × девайс**. Ниже неё зона, формат и сетка есть только у AdSpyglass, а закупка известна только на уровне сайт × страна.

```prisma
// ---------- Справочники ----------

model Site {
  id            String   @id @default(cuid())
  domain        String   @unique          // japan-whores.com
  title         String
  adsgSiteId    String?  @unique          // 137648
  metrikaId     String?                   // counter id
  status        SiteStatus @default(ACTIVE)
  launchedAt    DateTime?
  bundles       BundleSite[]
  revenue       FactRevenue[]
  traffic       FactTraffic[]
  costs         FactCost[]
  deals         FactFixDeal[]
  @@index([status])
}

enum SiteStatus { ACTIVE PAUSED ARCHIVED }

model Bundle {
  id        String  @id @default(cuid())
  slug      String  @unique               // jav, hentai, gay
  title     String
  color     String                        // hex для графиков
  sites     BundleSite[]
}

// Сайт может входить в несколько бандлов
model BundleSite {
  bundleId  String
  siteId    String
  bundle    Bundle @relation(fields: [bundleId], references: [id], onDelete: Cascade)
  site      Site   @relation(fields: [siteId],   references: [id], onDelete: Cascade)
  @@id([bundleId, siteId])
}

model Country {
  code      String @id                    // ISO-3166 alpha-2: JP
  nameEn    String
  tier      Int                           // 1 | 2 | 3
  aliases   CountryAlias[]
  @@index([tier])
}

// "Hashemite Kingdom of Jordan", "Myanmar [Burma]", "Scotland"
model CountryAlias {
  raw         String  @id
  countryCode String
  source      String                      // adspyglass | metrika
  country     Country @relation(fields: [countryCode], references: [code])
}

model Zone {
  id         String @id @default(cuid())
  adsgZoneId String @unique               // 491410
  siteId     String
  name       String                       // Banners_Footer_A
  format     AdFormat
  position   String?                      // footer | player | grid
  isActive   Boolean @default(true)
  @@index([siteId, format])
}

enum AdFormat { POPUNDER BANNER NATIVE SLIDER OUTSTREAM INVIDEO INPAGEPUSH }

model Network {
  id       String  @id @default(cuid())
  slug     String  @unique               // adpulsar | clickadu | own_deals
  title    String
  color    String                        // фиксированный цвет во всех графиках
  kind     NetworkKind
}

enum NetworkKind { MEDIATED DIRECT MARKETPLACE }

// ---------- Факты ----------

model FactRevenue {
  date             DateTime  @db.Date
  siteId           String
  zoneId           String?
  format           AdFormat
  networkId        String
  countryCode      String
  device           Device
  pageLoads        Int       @default(0)
  impsOwn          Int       @default(0)
  impsNetwork      Int       @default(0)
  views            Int       @default(0)   // видимые показы, только баннеры
  clicks           Int       @default(0)
  revenueReported  Decimal   @db.Decimal(12, 4)
  revenueConfirmed Decimal?  @db.Decimal(12, 4)
  @@id([date, siteId, zoneId, format, networkId, countryCode, device])
  @@index([date, siteId])
  @@index([date, countryCode])
}

enum Device { DESKTOP MOBILE TABLET TV CONSOLE UNKNOWN }

model FactTraffic {
  date         DateTime @db.Date
  siteId       String
  countryCode  String
  device       Device
  uniques      Int
  pageviews    Int
  sessions     Int
  bounceRate   Decimal? @db.Decimal(5, 2)
  avgDepth     Decimal? @db.Decimal(6, 2)
  @@id([date, siteId, countryCode, device])
  @@index([date, siteId])
}

model FactCost {
  date          DateTime @db.Date
  siteId        String
  countryCode   String
  sourceSlug    String                    // tubetraffic | tubecrown
  uniquesBought Int
  rateModel     RateModel
  rate          Decimal  @db.Decimal(10, 5)
  cost          Decimal  @db.Decimal(12, 4)
  @@id([date, siteId, countryCode, sourceSlug])
  @@index([date, siteId])
}

enum RateModel { CPM CPC CPU FLAT }

// Ставка по умолчанию — чтобы не вбивать каждый день руками
model CostRate {
  id          String    @id @default(cuid())
  siteId      String?                     // null = на все сайты
  countryCode String?                     // null = на все гео
  sourceSlug  String
  rateModel   RateModel
  rate        Decimal   @db.Decimal(10, 5)
  validFrom   DateTime  @db.Date
  validTo     DateTime? @db.Date
  @@index([sourceSlug, validFrom])
}

model FactFixDeal {
  date          DateTime @db.Date
  dealId        String
  siteId        String
  countryCode   String
  pageLoads     Int      @default(0)
  impsOwn       Int      @default(0)
  impsReported  Int      @default(0)      // счётчик рекламодателя
  cpm           Decimal  @db.Decimal(10, 5)
  revenue       Decimal  @db.Decimal(12, 4)
  isConfirmed   Boolean  @default(false)
  @@id([date, dealId, siteId, countryCode])
  @@index([date, siteId])
}

model Deal {
  id           String    @id @default(cuid())
  title        String
  advertiser   String
  format       AdFormat
  priceModel   RateModel                  // CPM | FLAT за 1000 загрузок
  price        Decimal   @db.Decimal(10, 5)
  geoScope     String[]                   // ISO-коды, пусто = все
  startsAt     DateTime  @db.Date
  endsAt       DateTime? @db.Date
  isActive     Boolean   @default(true)
}

// ---------- Служебное ----------

model IngestRun {
  id         String   @id @default(cuid())
  source     String                       // adspyglass | metrika
  dateFrom   DateTime @db.Date
  dateTo     DateTime @db.Date
  status     String                       // ok | failed | partial
  rowsUpsert Int      @default(0)
  rawKey     String?                      // ключ сырого ответа в R2
  error      String?
  startedAt  DateTime @default(now())
  finishedAt DateTime?
  @@index([source, startedAt])
}
```

### Замечания по схеме

**Составные первичные ключи вместо суррогатных.** Ингест идёт через `upsert` по натуральному ключу, поэтому повторный прогон за ту же дату переписывает строки, а не плодит дубли. Это же решает рестейт: AdSpyglass и Метрика правят вчерашние цифры, мы просто перетягиваем.

**`zoneId` nullable.** Гео-разрез AdSpyglass не отдаёт зону, форматный не отдаёт гео. Строки с `zoneId = null` — это гео-грануляция, с заполненным — зонная. Во вьюхах они не суммируются вместе, для каждой есть своя.

**`CountryAlias` заполняется на старте сидом и дополняется при ингесте.** Неизвестный алиас не роняет джоб: строка пишется с `countryCode = 'XX'` и попадает в отчёт «нераспознанные гео», который ты руками разбираешь раз в неделю.

**Цвет сетки и бандла лежит в базе.** Чтобы AdPulsar был одного цвета на всех графиках приложения, а не разного в зависимости от порядка в легенде.

## Ингест

Четыре воркера на BullMQ, все идемпотентные, все пишут в `IngestRun`.

| Джоб | Расписание | Окно | Грануляция |
| --- | --- | --- | --- |
| `adspyglass:geo` | каждый час | вчера + сегодня | сайт × сетка × гео × девайс |
| `adspyglass:zones` | каждый час | вчера + сегодня | сайт × зона × формат |
| `adspyglass:backfill` | 04:00 | T-1 … T-4 | оба разреза |
| `metrika` | каждый час | вчера + сегодня | сайт × гео × девайс |
| `metrika:backfill` | 04:30 | T-1 … T-4 | то же |

Рестейт обязателен: обе системы правят вчерашние цифры в течение нескольких суток. Окно T-4 закрывает почти все правки.

### AdSpyglass

Дёргаем два разреза, потому что один не отдаёт всё сразу:

- **Гео-разрез:** `group_by = site, network, country, device`. Даёт page loads, imps свои и сетевые, CTR, CPM, revenue. Включает own deals.
- **Зонный разрез:** `group_by = zone, format`. Даёт разбивку по спотам и видимые показы для баннеров. **Own deals сюда не попадают** — это не баг интеграции, а поведение платформы.

Пишем в `FactRevenue`: гео-разрез с `zoneId = null`, зонный с заполненным `zoneId` и `countryCode = 'ZZ'` (агрегат). Во вьюхах они не пересекаются.

Поле `views` заполняется только для форматов BANNER и NATIVE — из колонки Banner views. Без неё диагностика баннеров невозможна, а именно там прячется главная потеря.

```ts
// Скелет клиента
async function fetchAdsg(params: {
  dateFrom: string; dateTo: string;
  groupBy: string[]; siteId?: string;
}): Promise<AdsgRow[]> {
  const res = await fetch(ADSG_ENDPOINT, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.ADSG_TOKEN}` },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new IngestError('adspyglass', res.status);
  const json = await res.json();
  await putRaw(`adsg/${params.groupBy.join('-')}/${params.dateFrom}.json`, json);
  return json.rows;
}
```

### Яндекс Метрика

Stat API v1, `/stat/v1/data`.

```
metrics:    ym:s:users, ym:pv:pageviews, ym:s:visits,
            ym:s:bounceRate, ym:s:pageDepth
dimensions: ym:s:regionCountry, ym:s:deviceCategory
date1/date2: окно джоба
id:         counter id сайта
```

Один счётчик на сайт, `Site.metrikaId`. Лимит 200 запросов в секунду на приложение — при 40 сайтах и часовом расписании не упираемся, но батчить запросы всё равно стоит по 5 параллельно.

Осторожно с `ym:pv:pageviews` и `ym:s:users` в одном запросе: они из разных таблиц, и Метрика может отдать неконсистентную комбинацию. Надёжнее дёрнуть двумя запросами и склеить по ключу.

### Нормализация

Прогоняется на входе, до записи в факт-таблицы.

```ts
function normCountry(raw: string, source: string): string {
  const hit = countryAliasCache.get(`${source}:${raw}`)
           ?? countryAliasCache.get(`*:${raw}`);
  if (!hit) { unresolved.add({ raw, source }); return 'XX'; }
  return hit;
}

const DEVICE_MAP: Record<string, Device> = {
  desktop: 'DESKTOP', Desktop: 'DESKTOP',
  mobile: 'MOBILE',   Mobile: 'MOBILE',   phone: 'MOBILE',
  tablet: 'TABLET',   Tablet: 'TABLET',
  tv: 'TV',           TV: 'TV',
  Console: 'CONSOLE',
};
```

Сид `CountryAlias` кладём сразу на все странности, которые уже видели в выгрузках: Hashemite Kingdom of Jordan → JO, Myanmar [Burma] → MM, Republic of Korea → KR, Republic of Moldova → MD, Republic of the Congo → CG, Congo → CD, Scotland → GB, Åland → AX, Curaçao → CW, São Tomé and Príncipe → ST, East Timor → TL, Macedonia → MK, Cape Verde → CV.

### Закупка трафика

API у поставщиков либо нет, либо он неудобный, поэтому два пути ввода:

1. **Ставки по умолчанию.** Заполняешь `CostRate` один раз: источник × сайт × гео × период × модель × ставка. Ночной джоб берёт `FactTraffic.uniques` за день, находит подходящую ставку и пишет `FactCost`. Дальше руками ничего не нужно.
2. **Импорт CSV.** Для случаев, когда счёт пришёл с другими цифрами. Загрузка на `/settings/costs`, колонки `date, site, country, source, uniques, cost`, перезаписывает расчётное.

Приоритет: импортированное всегда бьёт расчётное.

### Фикс-дилы

Создаётся запись `Deal` — рекламодатель, формат, цена, гео-скоуп, период. Ночной джоб раскладывает её в `FactFixDeal` по дням и гео, беря page loads из `FactRevenue` по тому же срезу.

Важный момент: если дил оплачивается по CPM на счётчике рекламодателя, храним обе цифры — `impsOwn` и `impsReported`. Расхождение между ними и есть предмет разговора с рекламодателем, и оно должно быть видно в интерфейсе, а не всплывать при сверке платежа.

## Метрики и формулы

### Базовые

| Метрика | Формула | Где применяем |
| --- | --- | --- |
| **Rev / 1000 loads** | `revenue / page_loads × 1000` | Основная. Сравнение сеток внутри одного гео |
| **RPM на уника** | `revenue / uniques × 1000` | Сравнение сайтов и бандлов между собой |
| **CPM** | `revenue / imps_own × 1000` | Только внутри одного формата, между форматами бессмысленна |
| **Viewable CPM** | `revenue / views × 1000` | Баннеры и нативка. Единственная честная цена баннера |
| **View rate** | `views / imps_own` | Баннеры. Ниже 15% — проблема вёрстки, не цены |
| **Fill rate** | `imps_own / page_loads` | Сколько запросов вообще закрылось |
| **Дискрепанси** | `(imps_own − imps_network) / imps_own` | Отрицательная = рекламодатель считает больше |
| **Cost / unique** | `cost / uniques_bought` | Цена входа |
| **Margin** | `revenue − cost` | |
| **ROMI** | `(revenue − cost) / cost × 100%` | Главная цифра на страницах бандла и сайта |
| **Depth** | `pageviews / uniques` | Множитель между ценой уника и числом показов |

**rCPM в интерфейс не выводим.** Он считается на свои показы и поэтому завышает источники с низким филом — источник, который отвечает на 30% запросов по хорошей цене, выглядит лучше того, кто отвечает на 70% по чуть меньшей, хотя денег приносит меньше. Для сравнения источников используется только rev / 1000 loads.

### ROMI в разрезах

ROMI считается только там, где есть цена закупки, то есть на уровне сайт × страна и выше. По зонам, форматам и сеткам ROMI не определён — расход к ним не привязан. В интерфейсе в этих разрезах на его месте стоит доля в выручке.

### Вьюхи

```sql
-- Дневная свёртка по сайту и гео: доход из двух источников + расход
CREATE VIEW v_site_geo_daily AS
WITH rev AS (
  SELECT date, "siteId", "countryCode",
         SUM("pageLoads")        AS page_loads,
         SUM("impsOwn")          AS imps_own,
         SUM("impsNetwork")      AS imps_network,
         SUM("views")            AS views,
         SUM("revenueReported")  AS revenue_mediated
  FROM "FactRevenue"
  WHERE "zoneId" IS NULL              -- только гео-грануляция
  GROUP BY 1,2,3
),
deal AS (
  SELECT date, "siteId", "countryCode",
         SUM(revenue) AS revenue_direct,
         SUM("pageLoads") AS deal_loads
  FROM "FactFixDeal" GROUP BY 1,2,3
),
tr AS (
  SELECT date, "siteId", "countryCode",
         SUM(uniques) AS uniques, SUM(pageviews) AS pageviews
  FROM "FactTraffic" GROUP BY 1,2,3
),
cost AS (
  SELECT date, "siteId", "countryCode",
         SUM(cost) AS cost, SUM("uniquesBought") AS uniques_bought
  FROM "FactCost" GROUP BY 1,2,3
)
SELECT
  COALESCE(rev.date, deal.date, tr.date, cost.date)               AS date,
  COALESCE(rev."siteId", deal."siteId", tr."siteId", cost."siteId") AS site_id,
  COALESCE(rev."countryCode", deal."countryCode",
           tr."countryCode", cost."countryCode")                   AS country_code,
  COALESCE(rev.page_loads, 0) + COALESCE(deal.deal_loads, 0)      AS page_loads,
  COALESCE(rev.imps_own, 0)                                        AS imps_own,
  COALESCE(rev.imps_network, 0)                                    AS imps_network,
  COALESCE(rev.views, 0)                                           AS views,
  COALESCE(rev.revenue_mediated, 0)                                AS revenue_mediated,
  COALESCE(deal.revenue_direct, 0)                                 AS revenue_direct,
  COALESCE(rev.revenue_mediated, 0)
    + COALESCE(deal.revenue_direct, 0)                             AS revenue,
  COALESCE(tr.uniques, 0)                                          AS uniques,
  COALESCE(tr.pageviews, 0)                                        AS pageviews,
  COALESCE(cost.cost, 0)                                           AS cost,
  COALESCE(rev.revenue_mediated, 0)
    + COALESCE(deal.revenue_direct, 0) - COALESCE(cost.cost, 0)    AS margin
FROM rev
  FULL JOIN deal USING (date, "siteId", "countryCode")
  FULL JOIN tr   USING (date, "siteId", "countryCode")
  FULL JOIN cost USING (date, "siteId", "countryCode");
```

Остальные вьюхи строятся поверх факт-таблиц напрямую:

- `v_bundle_daily` — свёртка `v_site_geo_daily` через `BundleSite`, с полями revenue, cost, margin, romi, uniques, rpm
- `v_zone_daily` — из `FactRevenue WHERE "zoneId" IS NOT NULL`, с view rate и viewable CPM
- `v_network_geo` — сетка × гео × сайт, с fill rate, дискрепанси и rev/1000 loads
- `v_format_daily` — формат × сайт × день, средний CPM и доля в выручке

**Ключевое ограничение, которое надо соблюдать везде.** Сайт может входить в несколько бандлов, поэтому сумма выручки по всем бандлам не равна выручке сети. На странице сводки total считается по `Site`, а не суммированием бандлов, иначе цифры начнут расходиться на пересечениях.

## Дизайн-система

Это внутренний аналитический инструмент, в котором ты будешь сидеть каждый день. Значит: плотность важнее воздуха, цифры важнее декора, цвет — носитель смысла, а не украшение.

**Библиотеки.** Tailwind + shadcn/ui как база, TanStack Table для таблиц, Recharts для графиков, lucide-react для иконок. Ничего больше не тащим.

### Цветовые токены

Тёмная тема основная, светлая опциональная. Задаются как CSS-переменные в `globals.css`, Tailwind читает их через `@theme`.

```css
:root {
  /* поверхности */
  --bg:            #09090B;   /* фон приложения */
  --surface:       #131316;   /* карточки, таблицы */
  --surface-hover: #1C1C21;
  --border:        #26262C;
  --border-strong: #35353D;

  /* текст */
  --text:          #FAFAFA;
  --text-muted:    #8E8E99;   /* подписи, единицы измерения */
  --text-faint:    #5A5A66;   /* нули, пустые значения */

  /* семантика */
  --accent:        #4F8DF7;   /* выделение, ссылки, активная вкладка */
  --positive:      #22C55E;   /* рост, положительная маржа */
  --negative:      #F43F5E;   /* падение, убыток */
  --warning:       #F59E0B;   /* алерты, дискрепанси */

  /* заливки под значения в ячейках */
  --heat-pos:      #22C55E1F;
  --heat-neg:      #F43F5E1F;
}

[data-theme='light'] {
  --bg: #FFFFFF; --surface: #FAFAFA; --surface-hover: #F4F4F5;
  --border: #E4E4E7; --border-strong: #D4D4D8;
  --text: #09090B; --text-muted: #71717A; --text-faint: #A1A1AA;
}
```

**Правило по цвету.** Зелёный и красный только для маржи, ROMI и дельт. Никогда для категорий. Если в таблице все ROMI зелёные — значит цвет ничего не сообщает; заливку ячейки включаем только при отклонении больше 20% от среднего по разрезу.

### Категориальная палитра

Цвет сетки и бандла лежит в базе и одинаков во всех графиках приложения. Максимум шесть цветов, седьмая и далее категории схлопываются в «Прочее».

```
AdPulsar     #4F8DF7   TrafficStars  #A78BFA
Clickadu     #F472B6   ExoClick      #FBBF24
Own deals    #22C55E   Marketplace   #2DD4BF
Прочее       #52525B
```

Зелёный у own deals не случайно: прямые дилы — то, что ты растишь, и это должно читаться на графике без легенды.

### Типографика

```
Шрифт интерфейса:  Inter (или Geist Sans)
Шрифт цифр:        тот же, но font-variant-numeric: tabular-nums

Display   32px / 40  −0.02em  600   значение в KPI-карточке
H1        20px / 28  −0.01em  600   заголовок страницы
H2        15px / 22   0       600   заголовок блока
Body      14px / 20   0       400   основной текст
Table     13px / 18   0       400   ячейки таблиц
Label     12px / 16   0.01em  500   заголовки колонок, подписи
Mono      12px / 16   0       400   ID, домены, коды стран
```

**`tabular-nums` обязателен на всех числовых ячейках.** Без него колонка цифр не выравнивается по разрядам и таблицу невозможно сканировать глазом.

### Сетка и размеры

```
Базовый шаг       4px
Отступ страницы   24px
Зазор между карт. 16px
Высота строки табл. 36px (плотный режим 30px)
Радиус            8px карточки, 6px кнопки, 4px бейджи
Макс. ширина      1600px, контент центрируется
Сайдбар           240px, схлопывается до 56px
```

### Правила для таблиц

Это главный элемент интерфейса, на него стоит потратить больше всего внимания.

- Числа выровнены вправо, текст влево, заголовки числовых колонок тоже вправо
- Единицы измерения (`$`, `%`) в цвете `--text-muted`, на размер меньше значения
- Ноль рисуется как `—` в цвете `--text-faint`, не как `0.00`
- Сортировка по клику на заголовок, по умолчанию — по выручке убыв.
- Строка «Итого» закреплена снизу, с `border-top: 1px solid var(--border-strong)`
- Заголовок таблицы `position: sticky`
- Доля в выручке рисуется тонкой полосой-фоном внутри ячейки, а не отдельной колонкой с процентом
- Больше 25 строк — пагинация, не бесконечный скролл: при 200 странах иначе не жить

### Правила для графиков

- Без 3D, без градиентных заливок, без теней
- Ось Y начинается с нуля, кроме явных графиков дельты
- Сетка горизонтальная, `--border`, 1px, без вертикальных линий
- Тултип показывает все серии сразу, отсортированные по значению убыв.
- Легенда сверху, кликабельная для скрытия серий
- Разрыв в данных рисуется разрывом линии, а не нулём — иначе упавший ингест выглядит как обвал выручки
- Для сравнения форматов и сеток — stacked bar по дням; для динамики метрики — line; круговые диаграммы не используем нигде

## Компоненты

Восемь штук закрывают весь интерфейс. Больше на первой версии не нужно.

**`<KpiCard>`** — значение, подпись, дельта к предыдущему периоду, спарклайн за 14 дней.

```tsx
<KpiCard
  label="ROMI"
  value={142.7} format="percent"
  delta={+8.3} deltaMode="pp"     // pp | percent | abs
  spark={series}
  tone="auto"                      // auto красит дельту, neutral не красит
/>
```

Дельта считается к равному предыдущему периоду: выбран период в 7 дней — сравнение с предыдущими 7 днями. Для ROMI и других процентных метрик дельта в процентных пунктах, не в процентах от процента.

**`<DataTable>`** — обёртка над TanStack Table. Пропсы: `columns`, `data`, `totalsRow`, `density`, `defaultSort`, `onRowClick`. Колонка описывается типом значения, а не рендером — форматирование, выравнивание и цвет выводятся из типа автоматически.

```tsx
type ColumnKind =
  | 'text' | 'mono' | 'int' | 'money' | 'cpm'
  | 'percent' | 'delta' | 'share' | 'country' | 'site';
```

`share` рисует полосу-фон внутри ячейки. `country` рисует флаг плюс название. `site` — домен моноширинным плюс ссылку на страницу сайта. `cpm` — четыре знака после запятой, `money` — два.

**`<TrendChart>`** — line или stacked bar, переключается пропсом. Принимает серии с уже проставленными цветами из базы.

**`<PeriodPicker>`** — пресеты «Вчера / 7 дней / 30 дней / Этот месяц / Прошлый месяц» плюс произвольный диапазон. Значение живёт в URL как `?from=&to=`, чтобы ссылкой на разрез можно было делиться и чтобы работала кнопка «назад».

**`<BreakdownTabs>`** — переключатель разреза на странице сайта: Зоны / Форматы / Сетки / Гео / Девайсы. Тоже в URL, `?by=zones`.

**`<AlertBadge>`** — уровень (`warning` | `critical`), текст, ссылка на разрез, который его породил. Алерт без ссылки на конкретный срез бесполезен.

**`<DiscrepancyCell>`** — число плюс иконка. До ±10% нейтральный цвет, ±10–25% `--warning`, дальше `--negative`. Тултип показывает обе цифры показов.

**`<EmptyState>`** — три варианта, и они разные по смыслу: нет данных за период, ингест не отработал, фильтр ничего не нашёл. Второй вариант показывает время последнего успешного `IngestRun` и кнопку перезапуска — без этого ты будешь искать причину пустого графика в коде вместо очереди.

## Роутинг и лейаут

```
/                        Сводка по сети: KPI, бандлы, алерты
/bundles/[slug]          Страница бандла
/sites/[domain]          Страница сайта
/geo                     Все гео по сети: маржа, стоп-лист
/alerts                  Все активные алерты
/settings/sites          Сайты: добавление, привязка ID, статус
/settings/bundles        Бандлы и их состав
/settings/costs          Ставки закупки и импорт CSV
/settings/deals          Фикс-дилы и own deals
/settings/integrations   Токены API, статус ингеста, ручной перезапуск
```

**Лейаут.** Сайдбар 240px слева: логотип, навигация, переключатель темы, внизу — индикатор свежести данных («AdSpyglass 14 мин назад, Метрика 22 мин назад») с жёлтой точкой, если что-то старше двух часов.

Сверху на каждой странице контента — заголовок, `<PeriodPicker>` справа, под ними ряд KPI-карточек. Дальше блоки по вертикали.

Весь стейт фильтров — в URL. Никакого глобального стора, только `searchParams`. Ссылка на разрез должна открываться у другого человека в том же виде.

## Страница бандла

`/bundles/jav` — например, 10 сайтов JAV-бандла. Отвечает на вопрос «бандл в плюсе, и за счёт чего».

### Блок 1 — KPI

Шесть карточек в ряд, дельта к предыдущему равному периоду:

`Выручка` · `Расход` · `Маржа` · `ROMI` · `Уники` · `RPM на уника`

ROMI — главная цифра, карточка шире остальных. Отрицательная маржа красит карточку рамкой `--negative`, а не только цифру.

### Блок 2 — динамика

Stacked bar по дням: столбец = день, сегменты = форматы, линия поверх = расход. Видно и структуру дохода, и пробивает ли выручка расход каждый день, а не только в сумме за период.

Переключатель разбивки столбца: по форматам / по сайтам / по сеткам.

### Блок 3 — сайты бандла

Главная таблица страницы. Сортировка по марже убыв.

| Сайт | Уники | Просмотры | Глубина | Выручка | Расход | Маржа | ROMI | RPM/уник |

Строка кликабельна, ведёт на `/sites/[domain]`. Внизу закреплён «Итого». Колонка ROMI с заливкой: зелёная, если выше среднего по бандлу на 20%+, красная — если ниже нуля.

Это тот разрез, где сразу видно, что один сайт из десяти тащит бандл, а два работают в минус.

### Блок 4 — форматы

| Формат | Page loads | Показы | Fill rate | Ср. CPM | Выручка | Доля |

Средний CPM по бандлу считается как `выручка / показы × 1000` внутри формата — сравнивать CPM между форматами нельзя, и таблица это не поощряет: колонка «Доля» рядом показывает вклад в деньги, а он у форматов с высоким CPM часто маленький.

Для BANNER и NATIVE в этой же таблице две дополнительные колонки: **View rate** и **Viewable CPM**. Именно здесь видно, что баннер не дешёвый, а невидимый.

### Блок 5 — гео

Топ-20 стран по загрузкам, остальное схлопнуто в «Прочие».

| Страна | Тир | Уники | Выручка | Расход | Маржа | ROMI | Rev/1000 loads |

Фильтр «только убыточные» одной кнопкой. Это рабочий экран для решения, какие гео продолжать закупать.

### Блок 6 — сетки

| Сетка | Page loads | Доля объёма | Fill rate | Rev/1000 loads | Ранг по цене | Выручка |

Колонка «Ранг по цене» и колонка «Доля объёма» рядом не случайно: если четвёртая по цене сетка держит половину объёма, это видно без вычислений. Строки с инверсией подсвечиваются `--warning`.

### Пустой бандл

Если в бандле нет сайтов — `<EmptyState>` со ссылкой на `/settings/bundles`, а не пустые графики.

## Страница сайта

`/sites/japan-whores.com` — рабочий экран. Отвечает на вопрос «что на этом сайте крутить дальше».

### Шапка

Домен, бандлы, в которые он входит (кликабельные бейджи), статус, дата запуска. Справа `<PeriodPicker>`.

### Блок 1 — KPI

`Выручка` · `Расход` · `Маржа` · `ROMI` · `Уники` · `RPM на уника` · `Глубина`

Глубина (просмотров на уника) стоит рядом с RPM осмысленно: она множитель между ценой уника и числом показов, и её падение бьёт по выручке раньше, чем это видно в CPM.

### Блок 2 — динамика

Линия выручки и линия расхода на одной оси, площадь между ними залита `--heat-pos` или `--heat-neg`. Сразу видно дни, когда сайт работал в минус.

### Блок 3 — разрезы

Одна таблица с `<BreakdownTabs>` наверху. Пять вкладок, каждая — свой набор колонок.

**Зоны.** Главная вкладка для оптимизации вёрстки.

| Зона | Формат | Позиция | Показы | Видимые | View rate | CPM | Viewable CPM | Выручка | Доля |

Зоны с долей меньше 1% выручки помечаются бейджем «кандидат на снос». Зоны с view rate ниже 15% — бейджем «не видна». Именно эта таблица показывает, что четыре футерных баннера дают на всех вместе меньше, чем один слайдер.

**Форматы.**

| Формат | Page loads | Показы | Fill rate | CPM | Viewable CPM | Выручка | Доля |

Fill rate здесь ключевая: формат с филом 10% — это не «формат плохо платит», а «девять из десяти запросов не заполнены», и лечится это бэкфиллом, а не сменой формата.

**Сетки.**

| Сетка | Page loads | Доля объёма | Fill rate | Rev/1000 loads | Ранг | Дискрепанси | Выручка |

**Гео.**

| Страна | Тир | Уники | Page loads | Выручка | Расход | Маржа | ROMI | Rev/1000 loads |

Клик по строке страны разворачивает вложенную таблицу «сетки в этой стране» — тот самый разрез, ради которого иначе приходится делать отдельные выгрузки по каждой стране руками.

**Девайсы.**

| Девайс | Уники | Показы | CPM | Выручка | Доля |

### Блок 4 — алерты по сайту

Список `<AlertBadge>`, каждый со ссылкой на породивший разрез. Пусто — значит пусто, без заглушки «всё хорошо».

### Блок 5 — фикс-дилы на сайте

Активные дилы: рекламодатель, формат, гео-скоуп, цена, показы свои и рекламодателя, множитель, выручка, статус подтверждения.

Множитель больше 1.5× подсвечивается `--warning` с тултипом: «рекламодатель засчитывает в N раз больше показов, чем ваш счётчик». Это не обвинение, а повод проверить и перевести дил на оплату за загрузку вместо показа.

## Настройки

### `/settings/sites`

Таблица всех ~40 сайтов: домен, заголовок, AdSpyglass ID, счётчик Метрики, бандлы, статус, дата запуска, последний ингест.

Добавление сайта — одна строка инлайн, без модалки. Обязательны домен и хотя бы один из двух ID. Кнопка «Проверить» дёргает оба API на один день и показывает, пришли ли данные — это ловит опечатку в ID сразу, а не через сутки пустого графика.

Статусы: `ACTIVE` участвует везде, `PAUSED` не тянется ингестом но история сохраняется, `ARCHIVED` скрыт из списков.

Массовые действия: выделить несколько сайтов → добавить в бандл, сменить статус.

### `/settings/bundles`

Список бандлов: название, слаг, цвет, число сайтов, выручка за 30 дней.

Редактирование состава — два списка рядом, перетаскивание или чекбоксы. **Сайт может входить в несколько бандлов** — это по замыслу: japan-whores может быть и в JAV, и в отдельном бандле «топ-10 по выручке». В интерфейсе рядом с каждым сайтом показываются все его бандлы, чтобы не забывалось.

Предупреждение на странице сводки: сумма по бандлам не равна сети, если есть пересечения. Одна строка мелким шрифтом, но она должна быть.

### `/settings/costs`

Два блока.

**Ставки.** Таблица `CostRate`: источник, сайт (или «все»), гео (или «все»), модель, ставка, период действия. Новая ставка с той же областью автоматически закрывает предыдущую датой `validTo`. Разрешение конфликтов — от частного к общему: ставка на конкретный сайт+гео бьёт ставку на сайт, та бьёт глобальную.

**Импорт.** Загрузка CSV с колонками `date, domain, country, source, uniques, cost`. Предпросмотр перед записью: сколько строк распознано, сколько гео не смаплено, какая сумма получится. Импортированное всегда перекрывает расчётное по ставкам.

### `/settings/deals`

Список дилов: рекламодатель, формат, модель цены, цена, гео-скоуп, период, активность.

Форма дила — гео-скоуп задаётся либо списком стран, либо тиром, либо «все кроме». Для тир-1 фикс-дила на $0.80 CPM это один клик по «Тир 1», а не перечисление 48 стран.

Отдельная колонка «Оплата» с выбором: за показ рекламодателя / за свой показ / за 1000 загрузок / флэт в сутки. От неё зависит, какую цифру система берёт для расчёта выручки. По умолчанию ставим за 1000 загрузок — это единственная модель, где ты контролируешь знаменатель.

Кнопка «Подтвердить платёж» на периоде: проставляет `isConfirmed` и заполняет `revenueConfirmed`. До неё вся выручка по дилу в интерфейсе помечена как прогноз пунктирной рамкой.

### `/settings/integrations`

Токены AdSpyglass и Метрики, лог `IngestRun` за последние 7 дней: источник, окно, статус, строк записано, длительность, ошибка.

Кнопка ручного перезапуска с выбором даты — понадобится в первую же неделю.

Блок «Нераспознанные гео»: список сырых названий из `CountryAlias` со счётчиком, сколько строк ушло в `XX`, и поле для сопоставления с ISO-кодом. Разбирается раз в неделю за минуту.

## Алерты и рекомендации

Шесть правил, все считаются обычным SQL по ночам и складываются в таблицу `Alert`. Никакого ML — правила простые и объяснимые, а объяснимость здесь важнее точности.

### 1. Убыточное гео

```sql
SELECT site_id, country_code,
       SUM(revenue) AS rev, SUM(cost) AS cost,
       (SUM(revenue) - SUM(cost)) / NULLIF(SUM(cost), 0) * 100 AS romi
FROM v_site_geo_daily
WHERE date >= CURRENT_DATE - 7 AND cost > 0
GROUP BY 1, 2
HAVING SUM(revenue) < SUM(cost) AND SUM(cost) > 5
```

Уровень `critical`. Действие в тексте алерта: снизить закупку этого гео или поднять флор. Порог $5 отсекает шум по мелким странам.

### 2. Инверсия waterfall

Внутри `site × country` ранжируем сетки по rev/1000 loads и по доле объёма. Если сетка ниже 3-го места по цене держит больше 30% объёма — алерт.

```sql
WITH r AS (
  SELECT site_id, country_code, network_id,
         SUM(revenue) / NULLIF(SUM(page_loads), 0) * 1000 AS rev_per_k,
         SUM(page_loads) AS loads,
         SUM(page_loads) * 1.0
           / SUM(SUM(page_loads)) OVER (PARTITION BY site_id, country_code) AS vol_share,
         RANK() OVER (PARTITION BY site_id, country_code
                      ORDER BY SUM(revenue) / NULLIF(SUM(page_loads), 0) DESC) AS price_rank
  FROM v_network_geo
  WHERE date >= CURRENT_DATE - 7
  GROUP BY 1, 2, 3
)
SELECT * FROM r WHERE price_rank > 3 AND vol_share > 0.30 AND loads > 10000
```

Уровень `warning`. В тексте: «переставить в waterfall ниже, объём отдать сетке X».

### 3. Аномальная дискрепанси

Сетка × гео, где `|дискрепанси| > 25%` два дня подряд при объёме больше 5000 показов. Уровень `warning`, в тексте обе цифры показов и множитель.

Отдельно: если дискрепанси отрицательная и множитель больше 2× — уровень `critical` и текст про перевод дила на оплату за загрузку.

### 4. Невидимая зона

Зоны формата BANNER или NATIVE с `view_rate < 15%` при объёме больше 50 000 показов за 7 дней.

В тексте: текущий view rate, viewable CPM, и оценка — сколько даст та же зона при view rate 35%. Это единственный алерт с прогнозом, и он оправдан, потому что viewable CPM уже известен и умножается на гипотетическое число видимых показов.

### 5. Мёртвая зона

Зона даёт меньше 1% выручки сайта и больше 5% его показов за 30 дней. Уровень `warning`, действие: снести и отдать место формату с более высоким CPM на том же сайте.

### 6. Низкий фил формата

Формат с `fill_rate < 25%` при объёме запросов больше 100 000 за 7 дней. Уровень `warning`, действие: подключить бэкфилл.

### Рекомендация флора

Считается не алертом, а колонкой в таблице сеток. Для каждого `site × country × format`:

```
floor = percentile_cont(0.6) WITHIN GROUP (ORDER BY rev_per_k)
        среди двух лучших источников за 14 дней
```

Источник, у которого rev/1000 loads систематически ниже этого флора, показывается с пометкой «ниже флора» — значит он занимает слот в waterfall, не оплачивая его.

### Страница `/alerts`

Все активные алерты списком, сгруппированы по уровню, фильтр по бандлу и сайту. Каждый — с прямой ссылкой на разрез, который его породил. Можно скрыть алерт на 30 дней кнопкой «принято к сведению», иначе список зарастёт.

## MCP-сервер

Отдельный route в том же Next.js-приложении: `/api/mcp`, streamable HTTP. Отдельный сервис не нужен — схема Prisma и так рядом.

**Принцип:** один универсальный инструмент плюс четыре формованных. Двадцать узких тулов — типичная ошибка, они не покрывают того, чего ты заранее не предусмотрел, и раздувают контекст описаниями.

### Инструменты

**`query(sql)`** — главный. Read-only роль Postgres с доступом **только к вьюхам**, не к таблицам. `statement_timeout = 10s`, `LIMIT 1000` навязывается автоматически, если его нет в запросе.

В описание тула кладём полную DDL всех вьюх — иначе имена колонок придётся угадывать, и половина запросов уйдёт в ошибки.

```sql
CREATE ROLE mcp_reader LOGIN PASSWORD '...';
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM mcp_reader;
GRANT SELECT ON v_site_geo_daily, v_bundle_daily, v_zone_daily,
                v_network_geo, v_format_daily TO mcp_reader;
ALTER ROLE mcp_reader SET statement_timeout = '10s';
```

**`get_pnl(date_from, date_to, group_by, bundle?, site?, country?)`** — свёртка маржи. `group_by` принимает `bundle | site | country | device | format | network`. Возвращает revenue, cost, margin, romi, uniques, rpm, rev_per_1k_loads.

**`get_network_matrix(site, date_from, date_to, country?)`** — сетка × гео: page loads, доля объёма, fill rate, rev/1000 loads, ранг по цене, дискрепанси. Тот разрез, ради которого иначе делаются выгрузки по каждой стране руками.

**`get_zones(site, date_from, date_to)`** — зоны с view rate, viewable CPM, долей в выручке и флагами «не видна» / «кандидат на снос».

**`get_alerts(level?, bundle?, site?)`** — активные алерты с контекстом и ссылками.

### Что положить в описания

В описании сервера — три вещи, без которых любой запрос будет неточным:

1. Что `rCPM` не используется, и почему для сравнения источников нужен `rev_per_1k_loads`
2. Что own deals лежат в `FactFixDeal` и не входят в зонный и форматный разрезы AdSpyglass
3. Что сайт может входить в несколько бандлов, поэтому сумма по бандлам ≠ сеть

Это ровно те три вещи, на которых ломается анализ, если про них не знать заранее.

### Подключение

Деплой на Coolify, свой домен, авторизация по bearer-токену в заголовке. Добавляется в Claude как кастомный коннектор по URL.

Без записи. Ни один инструмент не меняет данные — рекомендации остаются рекомендациями, биды ставит человек.

## План на 5 часов

Порядок важен: данные раньше интерфейса, иначе будешь рисовать экраны под несуществующие цифры и переделывать.

### Час 1 — фундамент

- `create-next-app`, Tailwind, shadcn/ui init, Prisma init
- Схема целиком из раздела «Модель данных», одна миграция
- Сид: 40 сайтов, 3 бандла, справочник стран с тирами, `CountryAlias` со всеми известными странностями, сетки с цветами
- `.env`: `DATABASE_URL`, `REDIS_URL`, `ADSG_TOKEN`, `METRIKA_TOKEN`, `R2_*`

Сид стран — самое скучное и самое важное в этом часе. Без него всё дальше не склеится.

### Час 2 — ингест

- Клиент AdSpyglass, оба разреза, запись сырья в R2
- Клиент Метрики, два запроса с последующей склейкой
- Нормализация стран и девайсов
- BullMQ: очередь, воркер, повторяющиеся джобы, `IngestRun`
- Прогон бэкфилла на 30 дней назад

К концу часа в базе лежат реальные данные. Дальше всё проверяется на них, а не на фикстурах.

### Час 3 — метрики и MCP

- Все пять вьюх
- Расчёт `FactCost` из `CostRate` ночным джобом
- Раскладка `Deal` в `FactFixDeal`
- Шесть правил алертов, таблица `Alert`, ночной джоб
- MCP route, роль `mcp_reader`, пять инструментов

**Тут первая контрольная точка.** Подключаешь MCP и спрашиваешь у меня что-нибудь вроде «покажи убыточные гео по JAV-бандлу за неделю». Если ответ осмысленный — модель и ингест верные, можно рисовать. Если нет — чинить сейчас, а не после UI.

### Час 4 — интерфейс

- Токены в `globals.css`, шрифт, тёмная тема
- Лейаут: сайдбар, шапка, `<PeriodPicker>`
- `<KpiCard>`, `<DataTable>` с типами колонок, `<TrendChart>`
- Страница бандла целиком
- Страница сайта с пятью вкладками разрезов

`<DataTable>` с типизированными колонками — ключевая экономия времени: описал колонку типом, получил форматирование, выравнивание и цвет бесплатно. Написать её один раз хорошо быстрее, чем верстать шесть таблиц руками.

### Час 5 — настройки и хвосты

- Четыре страницы настроек
- Сводка `/` и `/alerts`
- Пароль в middleware
- Деплой на Coolify, домен, подключение MCP как коннектора

### Чеклист готовности

- [ ] Ингест отработал за вчера, `IngestRun` зелёный по обоим источникам
- [ ] Нераспознанных гео меньше 1% строк
- [ ] Выручка за день в дашборде сходится с кабинетом AdSpyglass ±2%
- [ ] Own deals видны в выручке сайта и не задвоены с медиацией
- [ ] ROMI считается там, где заведены ставки закупки
- [ ] Сумма по сайтам бандла равна итогу бандла
- [ ] MCP отвечает на запрос через Claude
- [ ] Страница сайта открывается меньше чем за секунду на 30-дневном периоде

### Что делать сразу после

Первое, на что стоит посмотреть в готовом дашборде, — таблица зон по всем 40 сайтам разом, отсортированная по view rate. То, что на japan-whores нашлось за шесть выгрузок вручную, там будет видно по всей сети одним экраном.
