import { expect, test } from "@playwright/test";
import { login } from "./helpers";

// Phone layout: the sidebar is a drawer behind a top bar, nothing overflows the viewport sideways.
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

const PAGES = ["/", "/finance", "/forecast", "/sites", "/geo", "/deals", "/inventory", "/alerts", "/hypotheses", "/settings/sites", "/settings/integrations"];

test("mobile: drawer menu, no horizontal overflow on every page", async ({ page }) => {
  await login(page, "/sites");
  // The desktop sidebar is off-canvas; the top bar with the burger is visible.
  const aside = page.locator("aside");
  await expect(page.getByRole("button", { name: "Открыть меню" })).toBeVisible();
  await expect(aside.getByRole("link", { name: "Финансы" })).not.toBeInViewport();
  for (const path of PAGES) {
    await page.goto(path);
    await expect(page.locator("h1").first()).toBeVisible();
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(over, `${path} overflows by ${over}px`).toBeLessThanOrEqual(1);
    // Nothing fixed hides the page title: the header starts below the top bar.
    const top = await page.locator("h1").first().evaluate((el) => el.getBoundingClientRect().top);
    expect(top, `${path} title under the top bar`).toBeGreaterThanOrEqual(56);
  }
  // Detail pages too: a site, a bundle, a deal card.
  for (const [list, link] of [["/sites", "tbody a[href^='/sites/']"], ["/bundles", "a[href^='/bundles/']"], ["/deals", "tbody tr a[href^='/deals/'], a[href^='/deals/c']"]] as const) {
    await page.goto(list);
    const href = await page.locator(link).first().getAttribute("href");
    if (!href) continue;
    await page.goto(href);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(over, `${href} overflows by ${over}px`).toBeLessThanOrEqual(1);
  }
  // Burger opens the drawer; a tap on an item navigates and closes it.
  await page.goto("/sites");
  await page.getByRole("button", { name: "Открыть меню" }).click();
  await expect(aside.getByRole("link", { name: "Алерты" })).toBeInViewport();
  await aside.getByRole("link", { name: "Алерты" }).click();
  await expect(page).toHaveURL(/\/alerts/);
  await expect(aside.getByRole("link", { name: "Финансы" })).not.toBeInViewport();
  // The period picker fits the width and still opens.
  await page.goto("/");
  await page.getByRole("button", { name: /\d{2}\.\d{2}\.\d{4} — \d{2}\.\d{2}\.\d{4}/ }).click();
  await expect(page.getByRole("button", { name: "Применить" })).toBeVisible();
});
