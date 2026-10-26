import { expect, test } from "./helpers";

test("the guide lists its pages and renders code, tables and images", async ({
  app,
  page,
}) => {
  await app.run("window.__app.commands.run('help.guide')");
  const tabs = page.locator(".guide-tab");
  await expect(tabs).toHaveCount(9);
  await tabs.filter({ hasText: "Export templates" }).click();
  await expect(page.locator(".guide-page h3")).toHaveText("Export templates");
  await expect(page.locator(".guide-page .guide-code").first()).toContainText(
    "@name Markdown table",
  );
  await expect(page.locator(".guide-page .guide-table").first()).toBeVisible();
  await expect(page.locator(".guide-page img")).toHaveCount(1);
  // links between pages work
  await tabs.filter({ hasText: "Generating code" }).click();
  await page
    .locator(".guide-page .guide-link", { hasText: "Export templates" })
    .click();
  await expect(page.locator(".guide-page h3")).toHaveText("Export templates");
});

test("help topics link into the guide", async ({ page, app }) => {
  await app.run("window.__app.commands.run('help.controls')");
  await page.locator(".help-search").fill("export templates");
  await page.locator(".help .guide-link").first().click();
  await expect(page.locator(".guide-page h3")).toHaveText("Export templates");
});
