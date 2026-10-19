import { expect, test } from "./helpers";

test("operations apply to the selection when one exists", async ({ app }) => {
  await app.setValue("0x00000ff0");
  await app.run("window.__app.cards[0].setSelection(4, 11)");
  await app.card().locator(".seg.ops .seg-btn", { hasText: "NOT" }).click();
  expect(await app.value()).toBe("0");
  await app.run("window.__app.cards[0].clearSelection()");
  await app.setValue("0x12345678");
  await app.card().locator(".more-ops").click();
  await app.menu("Swap bytes");
  expect(await app.value()).toBe("78563412");
});

test("selection editor sets just the selected bits", async ({ app }) => {
  await app.run("window.__app.cards[0].setSelection(4, 11)");
  await app.card().locator(".sel-edit").fill("FF");
  expect(await app.value()).toBe("ff0");
});

test("expression bar previews and applies", async ({ app, page }) => {
  await app.card().locator(".expr-toggle").click();
  const input = app.card().locator(".expr-bar .expr-input");
  await input.fill("0x1F << 3 | bit(31)");
  await expect(app.card().locator(".expr-bar .expr-preview")).toContainText("0x8000_00F8");
  await input.press("Enter");
  expect(await app.value()).toBe("800000f8");
  await input.fill("1 +");
  await expect(app.card().locator(".expr-bar .expr-preview")).toContainText("ends too early");
  await page.keyboard.press("Escape");
  await expect(app.card().locator(".expr-bar")).toHaveCount(0);
});

test("float chip is editable", async ({ app }) => {
  await app.card().locator(".stat-float .stat-edit").click();
  await app.card().locator(".stat-input").fill("1.5");
  await app.card().locator(".stat-input").press("Enter");
  expect(await app.value()).toBe("3fc00000");
  await expect(app.card().locator(".stat-float .stat-detail")).toHaveText("+1.5 × 2^0");
});

test("paste bytes little-endian", async ({ app, page }) => {
  await app.run("void window.__app.cards[0].pasteBytes()");
  await page.locator(".bytes-area").fill("78 56 34 12");
  await page.locator(".modal .seg-btn", { hasText: "Little-endian" }).click();
  await expect(page.locator(".modal .expr-preview")).toContainText("0x1234_5678");
  await page.locator(".modal-footer .primary").click();
  expect(await app.value()).toBe("12345678");
});

test("new value from an expression over other values", async ({ app, page }) => {
  await app.setValue("0x12345678");
  await app.run("window.__app.commands.run('value.fromExpr')");
  await page.keyboard.type("{Value 1} ^ 0xFF");
  await page.keyboard.press("Enter");
  await expect(page.locator(".card")).toHaveCount(2);
  expect(await app.value(1)).toBe("12345687");
});
