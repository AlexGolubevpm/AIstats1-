# 09. MCP-слой

## Где живёт

MCP — **route handler в том же Next.js-приложении**: `src/app/api/mcp/route.ts`, транспорт streamable HTTP (`@modelcontextprotocol/sdk`). Инструменты — в `src/server/mcp/`. Отдельный сервис не нужен: схема Prisma, вьюхи и формулы уже рядом, а деплой и так один.

```
Claude ──HTTPS + Bearer──► caddy ──► web /api/mcp
                                       ├─ проверка токена (хеш в базе)
                                       ├─ tools/list, tools/call
                                       └─ пул pg под ролью mcp_reader ──► только вьюхи v_*
```

Внешний URL: `https://<домен>/api/mcp`. Подключается в Claude как кастомный коннектор; токен выпускается на `/settings/access`.

## Принцип

Один универсальный инструмент и несколько «формованных». Двадцать узких тулов не покрывают того, что не предусмотрели заранее, и раздувают контекст описаниями.

**Только чтение.** Ни один инструмент не меняет данные. Рекомендации остаются рекомендациями.

## Инструменты

| Инструмент | Параметры | Возвращает |
| --- | --- | --- |
| `query` | `sql` | Строки результата. Только SELECT по вьюхам, `statement_timeout = 10s`, `LIMIT 1000` навязывается, если его нет. В описание кладётся полная DDL вьюх |
| `get_pnl` | `date_from`, `date_to`, `group_by: bundle \| site \| country \| device \| format \| network`, `bundle?`, `site?`, `country?` | revenue, revenue_confirmed, cost, margin, romi, uniques, rpm, rev_per_1k_loads |
| `get_network_matrix` | `site`, `date_from`, `date_to`, `country?` | Сетка × гео: page loads, доля объёма, fill rate, rev/1000 loads, ранг, дискрепанси, флор |
| `get_zones` | `site`, `date_from`, `date_to` | Зоны: view rate, viewable CPM, доля, флаги «не видна» / «кандидат на снос» |
| `get_alerts` | `level?`, `bundle?`, `site?` | Активные алерты с контекстом и ссылками на UI |
| `get_deals` | `status?`, `advertiser?`, `date_from?`, `date_to?` | Дилы: прогноз, выставлено, подтверждено, остаток, множитель |

`get_deals` добавлен к спецификации вместе с разделом фикс-дилов.

## Вьюхи, доступные MCP

`v_site_geo_daily`, `v_bundle_daily`, `v_zone_daily`, `v_network_geo`, `v_format_daily`, `v_deal_daily`, `v_alerts_active`. Все с суффиксом `_daily` содержат колонку `date`.

Плюс справочные `v_sites` и `v_bundles`.

```sql
CREATE ROLE mcp_reader NOLOGIN;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM mcp_reader;
GRANT SELECT ON v_sites, v_bundles, v_site_geo_daily, v_bundle_daily, v_zone_daily, v_network_geo,
                v_format_daily, v_deal_daily, v_alerts_active TO mcp_reader;
GRANT mcp_reader TO CURRENT_USER;
```

Роль без логина ([ADR 0004](../adr/0004-revenue-facts-and-billing.md)): `query` выполняется так —

```sql
BEGIN;
SET TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '10s';
SET LOCAL ROLE mcp_reader;
SELECT * FROM (<запрос>) AS _q LIMIT 1000;
COMMIT;
```

Роль и гранты создаются SQL-миграцией; тест проверяет, что `SELECT` из таблицы под этой ролью падает с `permission denied`.

## Что написано в описании сервера

Три вещи, без которых анализ ломается:

1. `rCPM` не используется: для сравнения источников нужен `rev_per_1k_loads`.
2. Own deals лежат в `FactFixDeal` и не входят в зонный и форматный разрезы AdSpyglass.
3. Сайт может входить в несколько бандлов, поэтому сумма по бандлам ≠ сеть.

Плюс: все деньги в USD; прогнозная выручка отличается от подтверждённой (`revenue` против `revenue_confirmed`).

## Защита `query`

- Парсинг SQL (`pgsql-ast-parser`, `server/mcp/sql-guard.ts`): ровно один оператор `SELECT` / `WITH … SELECT` / `UNION`; ссылки только на разрешённые вьюхи и CTE; `INSERT/UPDATE/DELETE` внутри CTE запрещены.
- Функции — только из белого списка (агрегаты, математика, даты, строки, оконные). `set_config`, `pg_*`, `query_to_xml`, `dblink` и любые схемо-квалифицированные вызовы отклоняются: без этого запрос мог бы вернуть себе права сессии.
- Навязанный `LIMIT 1000`: запрос оборачивается во внешний `SELECT … LIMIT 1000`; в ответе флаг `truncated`.
- Второй рубеж — права роли: даже если парсер пропустит лишнее, таблицы недоступны.
- Каждый вызов логируется JSON-строкой в stdout: инструмент, параметры, время, число строк или ошибка.

## Транспорт

Streamable HTTP без сессий: на каждый запрос — новый `McpServer` и `WebStandardStreamableHTTPServerTransport` с JSON-ответом. Без токена — `401`. Токен: выпущенный на `/settings/access` (в базе только sha256) или `MCP_TOKEN` из env. Формованные инструменты используют те же функции `server/queries`, что и страницы, поэтому ответ совпадает с блоком UI; ссылки в `get_alerts` абсолютные, если задан `APP_URL`.

## Проверка

Контрольная точка из плана: подключить коннектор и спросить «покажи убыточные гео JAV-бандла за неделю». Ответ должен совпасть с блоком «Гео» на `/bundles/jav` с фильтром «Только убыточные». Этот сценарий фиксируется интеграционным тестом `get_pnl` против той же фикстуры.
