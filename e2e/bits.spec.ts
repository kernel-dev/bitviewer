import { expect, test } from "./helpers";

test("click flips a bit, typing sets the value, Esc reverts bad input", async ({ app, page }) => {
  await app.bit(0).click();
  expect(await app.value()).toBe("1");
  const field = app.card().locator(".value-edit");
  await field.fill("dead_beef");
  expect(await app.value()).toBe("deadbeef");
  await field.pressSequentially("z");
  await expect(field).toHaveClass(/invalid/);
  await field.press("Escape");
  await expect(field).toHaveValue("DEAD_BEEF");
  await expect(field).not.toHaveClass(/invalid/);
  await page.keyboard.press("Control+z");
  expect(await app.value()).toBe("1");
});

test("drag selects, Ctrl+G names a field, clicking elsewhere keeps named fields", async ({ app, page }) => {
  await app.drag(app.bit(11), app.bit(4));
  expect(await app.run("JSON.stringify(window.__app.cards[0].sel)")).toBe("[4,11]");
  await page.keyboard.press("Control+g");
  await page.locator(".modal input").fill("CTRL");
  await page.keyboard.press("Enter");
  await expect(app.card().locator(".field-row")).toHaveCount(1);
  await app.drag(app.bit(3), app.bit(0));
  await app.card().locator(".fields-head").click();
  expect(await app.run("window.__app.cards[0].sel")).toBeNull();
  expect(await app.run("window.__app.cards[0].model.groups.map(g => g.name).join()")).toBe("CTRL");
});

test("keyboard moves the cursor and edits bits", async ({ app, page }) => {
  await app.bit(0).click(); // value 1, cursor on bit 0
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Space"); // bit 2
  expect(await app.value()).toBe("5");
  await page.keyboard.press("Shift+ArrowLeft");
  expect(await app.run("JSON.stringify(window.__app.cards[0].sel)")).toBe("[2,3]");
  await page.keyboard.press("Home");
  expect(await app.run("window.__app.cards[0].cursor")).toBe(31);
  await page.keyboard.press("1");
  expect(await app.value()).toBe("80000005");
});

test("Alt+drag paints bits and one Ctrl+Z undoes the stroke", async ({ app, page }) => {
  await app.drag(app.bit(23), app.bit(16), ["Alt"]);
  expect(await app.value()).toBe("ff0000");
  await app.drag(app.bit(20), app.bit(18), ["Alt", "Shift"]);
  expect(await app.value()).toBe("e30000");
  await page.keyboard.press("Control+z");
  expect(await app.value()).toBe("ff0000");
});

test("compare rows remember their value when closed", async ({ app }) => {
  const toggle = app.card().locator(".card-tools .btn", { hasText: "Compare" });
  await toggle.click();
  await app.card().locator('.strip.cmp .bit[data-bit="19"] .cell').click();
  await toggle.click();
  await expect(app.card().locator(".strip.cmp")).toHaveCount(0);
  await toggle.click();
  expect(await app.run("window.__app.cards[0].model.compareValue(0).toString(16)")).toBe("80000");
});

test("widths from 1 to 512 bits, and wrapping lines", async ({ app, page }) => {
  await page.keyboard.press("Control+3");
  await page.locator(".width-input").fill("600");
  await expect(page.locator(".modal-footer .primary")).toBeDisabled();
  await page.locator(".width-input").fill("100");
  await page.keyboard.press("Enter");
  await expect(page.locator(".card")).toHaveCount(2);
  expect(await app.run("window.__app.cards[1].model.width")).toBe(100);
  // 100 bits don't fit one line at this size: first line holds bits 99..64
  const lines = app.card(1).locator(".strip:not(.cmp) .bit-line");
  await expect.poll(() => lines.count()).toBeGreaterThan(1);
});
