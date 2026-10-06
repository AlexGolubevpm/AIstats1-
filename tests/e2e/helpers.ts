import { expect, type Page } from "@playwright/test";
import { E2E_LOGIN, E2E_PASSWORD } from "../../playwright.config";

export async function login(page: Page, next = "/") {
  await page.goto(`/login${next === "/" ? "" : `?next=${encodeURIComponent(next)}`}`);
  await page.getByLabel("Логин").fill(E2E_LOGIN);
  await page.getByLabel("Пароль").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}
