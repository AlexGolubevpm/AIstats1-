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
