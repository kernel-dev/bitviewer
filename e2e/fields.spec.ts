import { expect, test } from "./helpers";

test("template, formula entry, named values and protected bits", async ({ app, page }) => {
  await app.run("window.__app.commands.run('value.fromTemplate')");
  await page.locator(".tpl-item", { hasText: "IEEE-754 float32" }).click();
  await page.locator(".modal-footer .primary").click();
  const card = app.card(1);
  await expect(card.locator(".field-row")).toHaveCount(3);
  await app.setValue("0x3fc00000", 1); // 1.5

  // EXPONENT has the formula x - 127: typing 3 stores 130 → 12.0
  const exp = card.locator(".field-row").nth(1).locator(".decoded-edit");
  await expect(exp).toHaveValue("0");
  await exp.fill("3");
  await exp.press("Enter");
  expect(await app.value(1)).toBe("41400000");

  // details: SIGN becomes read-only with named values
  await card.locator(".field-row").first().locator(".btn.ghost.sm").first().click();
  await page.locator(".modal .seg-btn", { hasText: "Read-only" }).click();
  await page.locator(".modal .btn", { hasText: "Add named value" }).click();
  await page.keyboard.type("0");
  await page.keyboard.press("Tab");
  await page.keyboard.type("positive");
  await page.locator(".modal .btn", { hasText: "Add named value" }).click();
  await page.keyboard.type("1");
  await page.keyboard.press("Tab");
  await page.keyboard.type("negative");
  await page.locator(".modal-footer .primary").click();
  await expect(card.locator(".named-pick")).toHaveText("positive");

  // clicking a read-only bit asks; Cancel leaves it
  await app.bit(31, 1).click();
  await expect(page.locator(".modal h2")).toHaveText("Change a read-only field?");
  await page.locator(".modal-footer .btn", { hasText: "Cancel" }).click();
  expect(await app.value(1)).toBe("41400000");
  await app.bit(31, 1).click();
  await page.locator(".modal-footer .btn", { hasText: "Change it" }).click();
  expect(await app.value(1)).toBe("c1400000");
  await expect(card.locator(".named-pick")).toHaveText("negative");
});

test("shrinking below a named field is refused", async ({ app, page }) => {
  await app.run("window.__app.cards[0].model.addGroup(8, 15, 'CTRL')");
  await app.run("void window.__app.resizeValue(window.__app.cards[0])");
  await page.locator(".width-input").fill("8");
  await page.keyboard.press("Enter");
  // the width dialog may still be fading out, so look at the one that's showing
  await expect(page.locator(".backdrop.show .modal h2")).toHaveText("Fields don't fit");
  await page.keyboard.press("Escape");
  expect(await app.run("window.__app.cards[0].model.width")).toBe(32);
});

test("code export shows C and Rust", async ({ app, page }) => {
  await app.run("window.__app.cards[0].model.addGroup(4, 5, 'MODE')");
  await app.run("window.__app.cards[0].exportCode()");
  await expect(page.locator(".code-preview")).toContainText("#define VALUE_1_MODE_MASK  (0x3U << VALUE_1_MODE_POS)");
  await page.locator(".modal .seg-btn", { hasText: "Rust" }).click();
  await expect(page.locator(".code-preview")).toContainText("pub const fn set_mode(reg: u32, v: u32) -> u32 {");
});
