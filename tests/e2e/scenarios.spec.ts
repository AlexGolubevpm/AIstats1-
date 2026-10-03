// The minimum E2E scenarios from docs/engineering/10-testing.md.
import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test("1. password login → overview with non-empty KPIs; pages are closed without a session", async ({ page, request }) => {
  expect((await request.get("/api/export/month?month=2026-09")).status()).toBe(401);
  await page.goto("/finance");
  await expect(page).toHaveURL(/\/login\?next=%2Ffinance/);
  await login(page);
  await expect(page.getByRole("heading", { name: "Сводка" })).toBeVisible();
  await expect(page.getByText("Выручка").first()).toBeVisible();
  await expect(page.locator("text=/\\$\\d/").first()).toBeVisible();
});

test("2. overview → bundle → site → geo; the URL keeps the cut and Back returns to it", async ({ page }) => {
  await login(page);
  await page.getByRole("link", { name: "JAV" }).first().click();
  await expect(page).toHaveURL(/\/bundles\/jav/);
  await page.locator("table a[href^='/sites/']").first().click();
  await expect(page).toHaveURL(/\/sites\/[^/?]+/);
  const siteUrl = page.url();
  await page.getByRole("link", { name: "Гео" }).last().click();
  await expect(page).toHaveURL(/by=geo/);
  await page.locator("table").getByRole("button", { name: "Развернуть" }).first().click();
  await expect(page.locator("table").getByRole("button", { name: "Свернуть" }).first()).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(siteUrl);
  await page.getByRole("link", { name: "Источники" }).last().click();
  await expect(page).toHaveURL(/by=sources/);
  await expect(page.getByText("Ошибка")).toHaveCount(0);
});

test("3. add a site in settings → it is listed", async ({ page }) => {
  await login(page, "/settings/sites");
  await page.getByRole("button", { name: "Добавить сайт" }).click();
  await page.locator("input[name=domain]").fill("https://www.New-E2E-Tube.com/");
  await page.locator("input[name=adsgSiteId]").fill("999001");
  await page.getByRole("button", { name: "Добавить сайт" }).last().click();
  await expect(page.getByText("Сайт сохранён")).toBeVisible();
  await expect(page.getByRole("button", { name: "new-e2e-tube.com" })).toBeVisible();
});

test("4. new deal → enter period → payment → paid in the payments register", async ({ page }) => {
  await login(page, "/deals");
  await page.getByRole("button", { name: "Новый дил" }).click();
  await page.locator("input[name=advertiser]").fill("E2E Media");
  await page.locator("input[name=title]").fill("E2E баннер");
  await page.locator("input[name=price]").fill("0.8");
  await page.getByRole("checkbox", { name: "japan-tube.demo" }).check();
  await page.locator("input[name=startsAt]").fill("2026-08-01");
  await page.locator("input[name=endsAt]").fill("2026-08-31");
  await page.getByRole("button", { name: "Создать дил" }).click();
  await expect(page).toHaveURL(/\/deals\/[a-z0-9]+$/);
  await expect(page.getByRole("heading", { name: /E2E Media · E2E баннер/ })).toBeVisible();

  await page.getByRole("button", { name: "Внести", exact: true }).first().click();
  const amount = page.locator("input[name=amountInvoiced]");
  await expect(amount).not.toHaveValue("");
  await page.locator("input[name=impsReported]").fill("1000");
  await page.getByRole("button", { name: "Сохранить — Выставлено" }).click();
  await expect(page.getByText("Период внесён — Выставлено")).toBeVisible();

  await page.getByRole("button", { name: "Оплата" }).first().click();
  await page.getByRole("button", { name: "Сохранить — Подтверждено" }).click();
  await expect(page.getByText("Оплата подтверждена")).toBeVisible();
  await expect(page.getByText("оплачено").first()).toBeVisible();

  await page.goto("/deals?tab=payments");
  await expect(page.getByText("E2E Media").first()).toBeVisible();
});

test("5. cost CSV import → preview → apply → listed in history, then revert", async ({ page }) => {
  await login(page, "/settings/costs");
  const csv = "date,domain,country,source,uniques,cost\n2026-09-20,japan-tube.demo,Japan,tubecrown,1000,99.5\n2026-09-20,ghost.demo,JP,tubecrown,1,1\n";
  await page.locator("input[type=file]").setInputFiles({ name: "e2e-costs.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await expect(page.getByText("Распознано: 1")).toBeVisible();
  await expect(page.getByText("Домены не найдены: ghost.demo")).toBeVisible();
  await page.getByRole("button", { name: "Импортировать 1 строк" }).click();
  await expect(page.getByText("Импортировано строк: 1")).toBeVisible();
  await page.reload();
  await expect(page.getByText("e2e-costs.csv")).toBeVisible();
  await page.getByRole("button", { name: "Откатить импорт" }).first().click();
  await expect(page.getByText("Импорт откатан")).toBeVisible();
});

test("MCP answers with a token issued in settings", async ({ page, request }) => {
  await login(page, "/settings/access");
  await page.getByRole("button", { name: "Выпустить токен" }).click();
  const token = (await page.locator("code").filter({ hasText: "tsmcp_" }).textContent())!.trim();
  const r = await request.post("/api/mcp", {
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "query", arguments: { sql: "SELECT count(*) n FROM v_sites" } } },
  });
  expect(r.status()).toBe(200);
  expect(JSON.stringify(await r.json())).toContain("\\\"n\\\":");
});

test("readiness: a site page over 30 days renders in under a second", async ({ page }) => {
  await login(page, "/sites");
  const href = await page.locator("table a[href^='/sites/']").first().getAttribute("href");
  await page.request.get(`${href}?preset=30d`); // warm up the route
  const t0 = Date.now();
  const r = await page.request.get(`${href}?preset=30d`);
  const ms = Date.now() - t0;
  expect(r.status()).toBe(200);
  expect(ms, `server render took ${ms} ms`).toBeLessThan(1000);
});

test("formats: the inventory grid lists places; a free place can be marked CPA", async ({ page }) => {
  await login(page, "/inventory");
  await expect(page.getByRole("columnheader", { name: /Tablink 1/ })).toBeVisible();
  await page.locator("table").getByRole("button", { name: "свободно" }).first().click();
  await page.getByRole("dialog").locator("select[name=use]").selectOption("CPA");
  await page.getByRole("dialog").locator("input[name=note]").fill("e2e offer");
  await page.getByRole("dialog").getByRole("button", { name: "Сохранить" }).click();
  await expect(page.getByText("Сохранено")).toBeVisible();
  await expect(page.locator("table").getByRole("button", { name: "CPA" }).first()).toBeVisible();
  await page.getByRole("link", { name: "Только со свободными" }).click();
  await expect(page).toHaveURL(/free=1/);
  // The deals table under the grid lists the demo deals with who / how much / until when.
  const deals = page.locator("section", { hasText: "Фикс-дилы" }).last();
  await expect(deals.getByRole("cell", { name: /Sakura Media/ }).first()).toBeVisible();
  await expect(deals.getByRole("columnheader", { name: "По" })).toBeVisible();
  await deals.getByRole("button", { name: "Без места" }).click();
  await expect(deals.getByRole("cell", { name: /Sakura Media/ }).first()).toBeVisible(); // demo deals have no place yet
});

test("formats: period in the URL, bundle filter and grouping, a zone mapped by hand brings its revenue into the cell", async ({ page }) => {
  await login(page, "/inventory");
  // Period picker writes ?preset=; the sub-line carries the network revenue for it.
  await page.locator("button[aria-haspopup=dialog]", { hasText: "7 дней" }).click();
  await page.getByRole("button", { name: "30 дней", exact: true }).click();
  await expect(page).toHaveURL(/preset=30d/);
  // Bundle filter keeps only the bundle's sites; grouping adds a subtotal row per bundle.
  await page.getByLabel("Бандл", { exact: true }).selectOption("jav");
  await expect(page).toHaveURL(/bundle=jav/);
  await expect(page.locator("tbody a[href^='/sites/']")).toHaveCount(4);
  await page.getByLabel("Бандл", { exact: true }).selectOption("");
  await expect(page).not.toHaveURL(/bundle=/); // links on the page carry the current filters, so wait for the reset to render
  await expect(page.locator("tbody a[href^='/sites/']")).not.toHaveCount(4);
  await page.getByRole("link", { name: "Группировать по бандлам" }).click();
  await expect(page).toHaveURL(/group=bundle/);
  await expect(page.getByRole("cell", { name: /^JAV · 4 сайтов/ })).toBeVisible();
  await expect(page.getByRole("cell", { name: /^Топ-сайты · 3 сайтов/ })).toBeVisible();
  await page.getByRole("link", { name: "Без группировки" }).click();
  // Demo zones carry no place name, so every site shows "N зон без формата"; mapping one moves its money into the column.
  const row = page.locator("tbody tr").first();
  await expect(row.getByRole("button", { name: /зон без формата/ })).toBeVisible();
  const freeBefore = await row.getByRole("button", { name: "свободно" }).count(); // an earlier test may have marked one CPA
  await row.getByRole("button", { name: /зон без формата/ }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("cell", { name: "Banners_Sidebar" })).toBeVisible();
  await sheet.getByLabel("Формат зоны Banners_Sidebar").selectOption("under_bar");
  await expect(page.getByText("Формат зоны сохранён")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(row.getByRole("button", { name: "свободно" })).toHaveCount(freeBefore - 1);
  await expect(row.getByRole("button", { name: /^\$[\d,.]+/ }).first()).toBeVisible();
});

test("finance: an operating expense of a month lands in the month table, the KPIs and the P&L", async ({ page }) => {
  await login(page, "/finance?preset=prev_month");
  const prev = new Date(); prev.setUTCDate(1); prev.setUTCMonth(prev.getUTCMonth() - 1);
  const month = prev.toISOString().slice(0, 7);
  await page.getByRole("button", { name: "Добавить расход" }).click();
  const sheet = page.getByRole("dialog");
  await sheet.locator("input[name=month]").fill(month);
  await sheet.locator("input[name=title]").fill("E2E servers");
  await sheet.locator("select[name=category]").selectOption("HOSTING");
  await sheet.locator("input[name=amount]").fill("310");
  await sheet.getByRole("button", { name: "Сохранить" }).click();
  await expect(page.getByText("Расход сохранён")).toBeVisible();
  const opex = page.locator("section", { hasText: "Операционные расходы" }).last();
  await expect(opex.getByRole("cell", { name: /E2E servers/ })).toBeVisible();
  await expect(page.locator(`tr[data-month="${month}"]`)).toContainText("$310");
  await expect(page.getByText("Опер. расходы").first()).toBeVisible();
  await expect(page.locator("section", { hasText: "P&L по тьюбам" }).last().getByRole("columnheader", { name: "Опер. расходы" })).toBeVisible();
  await opex.getByRole("button", { name: "Удалить" }).first().click();
  await expect(page.getByText("Расход удалён")).toBeVisible();
});

test("forecast: the month is drawn day by day, the pace switch changes the URL, sites are projected", async ({ page }) => {
  await login(page, "/forecast");
  await expect(page.getByRole("heading", { name: "Прогноз" })).toBeVisible();
  await expect(page.getByText(/Прогноз выручки|Выручка за месяц/).first()).toBeVisible();
  await page.getByRole("link", { name: "3 дн." }).click();
  await expect(page).toHaveURL(/n=3/);
  await expect(page.locator("tr[data-kind=actual]").first()).toBeVisible();
  await expect(page.locator("tbody a[href^='/sites/']").first()).toBeVisible();
  await page.getByRole("link", { name: /^← / }).click();
  await expect(page).toHaveURL(/month=\d{4}-\d{2}/);
  await expect(page.locator("tr[data-kind=forecast]")).toHaveCount(0); // a finished month has no forecast rows
});

test("recommendations: the list opens, scope chips filter and change the URL", async ({ page }) => {
  await login(page, "/recommendations");
  await expect(page.getByRole("heading", { name: "Рекомендации", exact: true }).first()).toBeVisible();
  await expect(page.locator("li[data-scope]").first()).toBeVisible();
  await page.locator("a[href*='scope=format']").click();
  await expect(page).toHaveURL(/scope=format/);
  await expect(page.locator("li[data-scope]:not([data-scope=format])")).toHaveCount(0);
  await expect(page.getByText("Что сделать:").first()).toBeVisible();
});
