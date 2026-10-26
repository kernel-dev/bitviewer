import { expect, test } from "./helpers";

test("group values into a peripheral with a base address and offsets", async ({
  app,
  page,
}) => {
  // a value becomes the first register of a new peripheral
  await app.card().locator(".more-btn").click();
  // submenus open on hover (Playwright never sees their rows as "stable", so force it)
  await page
    .getByRole("menuitem", { name: "Peripheral ›" })
    .hover({ force: true });
  await page
    .getByRole("menuitem", { name: "New peripheral from this value…" })
    .click();
  const form = page.locator(".modal", { hasText: "New peripheral" });
  const inputs = form.locator("input");
  await inputs.nth(0).fill("UART0");
  await inputs.nth(1).fill("0x40011000");
  await inputs.nth(2).fill("Serial port");
  await inputs.nth(3).fill("0x4");
  await form.getByRole("button", { name: "OK" }).click();

  const block = page.locator(".periph", { hasText: "UART0" });
  await expect(block.locator(".periph-head")).toContainText("0x40011000");
  await expect(block.locator(".periph-head")).toContainText("1 register");
  await expect(block.locator(".card .badge.addr")).toHaveText("0x40011004");

  // add a register: it goes after the last one, 4 bytes on
  await block
    .locator(".periph-head .btn[aria-label='Peripheral actions']")
    .click();
  await app.menu("Add register");
  await expect(block.locator(".card")).toHaveCount(2);
  await expect(block.locator(".card .badge.addr").nth(1)).toHaveText(
    "0x40011008",
  );

  // a new loose value stays outside the block
  await page.keyboard.press("Control+1");
  await expect(page.locator(".workspace > .card")).toHaveCount(1);

  // the peripheral exports as a C struct with its base address
  await block.locator(".periph-head .btn", { hasText: "Export" }).click();
  const dialog = page.locator(".modal", {
    hasText: "Export code for peripheral",
  });
  await expect(dialog.locator(".code-preview")).toContainText(
    "#define UART0_BASE 0x40011000UL",
  );
  await expect(dialog.locator(".code-preview")).toContainText(
    "uint8_t           RESERVED0[4];",
  );
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // collapsing hides the registers; undo brings them back
  await block
    .locator(".periph-head .btn[aria-label='Hide the registers']")
    .click();
  await expect(block.locator(".periph-body")).toBeHidden();
  await page.keyboard.press("Control+z");
  await expect(block.locator(".periph-body")).toBeVisible();

  // the grouping is part of the workspace and survives a reload
  await page.waitForTimeout(1300); // session auto-save
  await page.reload();
  await expect(page.locator(".periph", { hasText: "UART0" })).toBeVisible();
  await expect(
    page.locator(".periph", { hasText: "UART0" }).locator(".card"),
  ).toHaveCount(2);
});

test("renaming a peripheral renames its registers", async ({ app, page }) => {
  await app.run(`(() => {
    const model = window.__app.cards[0].model;
    model.setName("UART0.CTRL");
    model.setPeripheral("UART0", 0n);
    window.__app.workspace.relayout();
  })()`);
  await page.locator(".periph-name", { hasText: "UART0" }).click();
  const form = page.locator(".modal", { hasText: "Peripheral “UART0”" });
  await form.locator("input").first().fill("UART1");
  await form.getByRole("button", { name: "OK" }).click();
  await expect(page.locator(".periph-name")).toHaveText("UART1");
  expect(await app.run("window.__app.cards[0].model.name")).toBe("UART1.CTRL");
  // one undo step puts both back
  await page.keyboard.press("Control+z");
  await expect(page.locator(".periph-name")).toHaveText("UART0");
  expect(await app.run("window.__app.cards[0].model.name")).toBe("UART0.CTRL");
});
