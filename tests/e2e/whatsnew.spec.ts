import { readFileSync } from "node:fs";
import { expect, test } from "./helpers";

const version: string = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
).version;

const dialog = (page: import("@playwright/test").Page) =>
  page.locator(".modal", { hasText: `Bit Viewer ${version} Changes` });

test("Help › What's new lists this version's changes", async ({
  app,
  page,
}) => {
  await expect(app.card()).toBeVisible();
  await page.keyboard.press("Control+k");
  await page.keyboard.type("what's new");
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).locator("h3").first()).toBeVisible();
  await expect(dialog(page).locator("li").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
});

test("shows once after an update, not on later starts", async ({
  app,
  page,
}) => {
  await expect(app.card()).toBeVisible();

  await page.evaluate(() => {
    const key = "bitviewer.settings";
    const saved = JSON.parse(localStorage.getItem(key) ?? "{}");
    localStorage.setItem(
      key,
      JSON.stringify({ ...saved, last_seen_version: "0.0.1" }),
    );
  });

  await page.reload();
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500); // let the settings write finish
  await page.reload();
  await page.waitForTimeout(1500);
  await expect(dialog(page)).toHaveCount(0);
});
