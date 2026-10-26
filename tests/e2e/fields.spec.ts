import { expect, test } from "./helpers";

test("template, formula entry, named values and protected bits", async ({
  app,
  page,
}) => {
  await app.run("window.__app.commands.run('value.fromTemplate')");
  await page.locator(".tpl-item", { hasText: "IEEE-754 float32" }).click();
  await page.locator(".modal-footer .primary").click();
  const card = app.card(1);
  await expect(card.locator(".field-row")).toHaveCount(3);
  await app.setValue("0x3fc00000", 1); // 1.5

  // EXPONENT has the formula x - 127: typing 3 stores 130 → 12.0
  const decodedInput = card
    .locator(".field-row")
    .nth(1)
    .locator(".decoded-edit");
  await expect(decodedInput).toHaveValue("0");
  await decodedInput.fill("3");
  await decodedInput.press("Enter");
  expect(await app.value(1)).toBe("41400000");

  // details: SIGN becomes read-only with named values
  await card
    .locator(".field-row")
    .first()
    .locator(".btn.ghost.sm")
    .first()
    .click();
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
  await expect(page.locator(".modal h2")).toHaveText(
    "Change a read-only field?",
  );
  await page.locator(".modal-footer .btn", { hasText: "Cancel" }).click();
  expect(await app.value(1)).toBe("41400000");
  await app.bit(31, 1).click();
  await page.locator(".modal-footer .btn", { hasText: "Change it" }).click();
  expect(await app.value(1)).toBe("c1400000");
  await expect(card.locator(".named-pick")).toHaveText("negative");
});

test("shrinking below a named field is refused", async ({ app, page }) => {
  await app.run("window.__app.cards[0].model.addGroup(8, 15, 'CTRL')");
  await app.run("window.__app.commands.run('card.width')");
  await page.locator(".width-input").fill("8");
  await page.keyboard.press("Enter");
  // the width dialog may still be fading out, so look at the one that's showing
  await expect(page.locator(".backdrop.show .modal h2")).toHaveText(
    "Fields don't fit",
  );
  await page.keyboard.press("Escape");
  expect(await app.run("window.__app.cards[0].model.width")).toBe(32);
});

test("code export shows C and Rust", async ({ app, page }) => {
  await app.run("window.__app.cards[0].model.addGroup(4, 5, 'MODE')");
  await app.run("window.__app.cards[0].exportCode()");
  await expect(page.locator(".code-preview")).toContainText(
    "#define REG_MODE_MASK  (0x3U << REG_MODE_POS)",
  );
  await page.locator(".modal .seg-btn", { hasText: "Rust" }).click();
  await expect(page.locator(".code-preview")).toContainText(
    "pub const fn set_mode(reg: u32, v: u32) -> u32 {",
  );
});

test("C struct follows the register width", async ({ app, page }) => {
  await app.run("window.__app.cards[0].model.setWidth(64)");
  await app.run("window.__app.cards[0].model.addGroup(28, 35, 'MID')");
  await app.run("window.__app.cards[0].exportCode()");
  const code = page.locator(".code-preview");
  await page.locator(".modal .seg-btn", { hasText: "C struct" }).click();
  await expect(code).toContainText("} reg_lower_t;");
  await expect(code).toContainText("MID_PART1");
  await page.locator(".modal .seg-btn", { hasText: "64-bit" }).click();
  await expect(code).toContainText("} reg_t;");
  await expect(code).not.toContainText("_lower");
});

test("write your own export template", async ({ app, page }) => {
  await app.run("window.__app.cards[0].model.addGroup(4, 5, 'MODE')");
  await app.run("window.__app.cards[0].exportCode()");
  await page
    .locator(".export-templates .btn[aria-label='New template']")
    .click();
  await page
    .locator(".tpl-source")
    .fill(
      "@name Lines\n@ext txt\n@for field in fields\n${field.id}=${field.range}\n@end\n",
    );
  await expect(page.locator(".tpl-preview")).toContainText("MODE=[5:4]");
  await expect(page.locator(".tpl-status")).toHaveText(
    "Saves as “Lines”, files end in .txt",
  );
  await page.locator(".modal-footer .primary").last().click();
  await expect(
    page.locator(".export-templates .seg-btn", { hasText: "Lines" }),
  ).toHaveCount(1);
  await expect(page.locator(".code-preview:not(.tpl-preview)")).toContainText(
    "MODE=[5:4]",
  );
  // a mistake is reported with its line number, and Save is off until it is fixed
  await page
    .locator(".export-templates .btn[aria-label='Edit this template']")
    .click();
  const editor = page.locator(".modal", { has: page.locator(".tpl-source") });
  await editor.locator(".tpl-source").fill("ok\n${nope}");
  await expect(editor.locator(".export-error")).toContainText(
    'Line 2: Unknown name "nope"',
  );
  await expect(editor.locator(".modal-footer .primary")).toBeDisabled();
});
