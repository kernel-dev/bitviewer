import { expect, test } from "./helpers";

const SVD = `<?xml version="1.0" encoding="utf-8"?>
<device>
  <name>DEMO</name>
  <size>32</size>
  <peripherals>
    <peripheral>
      <name>UART0</name>
      <baseAddress>0x40001000</baseAddress>
      <registers>
        <register>
          <name>CTRL</name>
          <description>Control register</description>
          <addressOffset>0x0</addressOffset>
          <resetValue>0x301</resetValue>
          <fields>
            <field><name>EN</name><bitOffset>0</bitOffset><bitWidth>1</bitWidth></field>
            <field>
              <name>MODE</name><bitRange>[9:8]</bitRange>
              <enumeratedValues>
                <enumeratedValue><name>Off</name><value>0</value></enumeratedValue>
                <enumeratedValue><name>Fast</name><value>3</value></enumeratedValue>
              </enumeratedValues>
            </field>
            <field><name>BUSY</name><bitOffset>31</bitOffset><bitWidth>1</bitWidth><access>read-only</access></field>
          </fields>
        </register>
        <register>
          <name>DATA</name>
          <addressOffset>0x4</addressOffset>
          <size>8</size>
        </register>
      </registers>
    </peripheral>
  </peripherals>
</device>`;

test("import registers from a CMSIS-SVD file", async ({ app, page }) => {
  const chooser = page.waitForEvent("filechooser");
  await app.run("window.__app.commands.run('file.importSvd')");
  await (await chooser).setFiles({
    name: "demo.svd",
    mimeType: "application/xml",
    buffer: Buffer.from(SVD),
  });
  const dialog = page.locator(".modal", { hasText: "Import from DEMO" });
  await expect(dialog).toBeVisible();
  // everything starts selected; the toggle clears it
  await expect(dialog.locator(".svd-count")).toHaveText("2 registers selected");
  await dialog
    .getByRole("button", { name: "Unselect all", exact: true })
    .click();
  await expect(dialog.locator(".svd-count")).toHaveText(
    "1 peripherals · 2 registers",
  );

  // filtering by a register name opens its peripheral
  await dialog.locator(".svd-search").fill("ctrl");
  await dialog
    .locator(".svd-reg", { hasText: "CTRL" })
    .locator("input")
    .check();
  await expect(dialog.locator(".svd-count")).toHaveText("1 register selected");
  await dialog.getByRole("button", { name: "Add value" }).click();
  await expect(dialog).toHaveCount(0);

  await expect(page.locator(".card")).toHaveCount(2);
  expect(await app.run("window.__app.cards[1].model.name")).toBe("UART0.CTRL");
  expect(await app.value(1)).toBe("301");
  expect(
    await app.run(
      "window.__app.cards[1].model.groups.map(g => `${g.name}:${g.access}`).join()",
    ),
  ).toBe("BUSY:ro,MODE:rw,EN:rw");
  await expect(app.card(1).locator(".named-pick")).toHaveText("Fast");
  // it lands in a UART0 peripheral block at the register's address
  const block = page.locator(".periph", { hasText: "UART0" });
  await expect(block.locator(".periph-head")).toContainText("0x40001000");
  await expect(block.locator(".card .badge.addr")).toHaveText("0x40001000");
  expect(await app.run("window.__app.cards[1].model.description")).toBe(
    "Control register",
  );

  // one undo removes the whole import
  await page.keyboard.press("Control+z");
  await expect(page.locator(".card")).toHaveCount(1);
});

test("save SVD registers as templates", async ({ app, page }) => {
  const chooser = page.waitForEvent("filechooser");
  await app.run("window.__app.commands.run('file.importSvd')");
  await (await chooser).setFiles({
    name: "demo.svd",
    mimeType: "application/xml",
    buffer: Buffer.from(SVD),
  });
  const dialog = page.locator(".modal", { hasText: "Import from DEMO" });
  await dialog.locator(".svd-periph input").check(); // the whole peripheral
  await expect(dialog.locator(".svd-count")).toHaveText("2 registers selected");
  await dialog.getByRole("button", { name: "Save as templates" }).click();
  await expect(page.locator(".toast")).toHaveText("Saved 2 templates");
  // settings are written a moment after the change
  await expect
    .poll(() =>
      app.run(
        "(JSON.parse(localStorage.getItem('bitviewer.settings')).templates ?? []).map(t => t.name).join()",
      ),
    )
    .toBe("DEMO UART0.CTRL,DEMO UART0.DATA");
});

test("select / unselect all, for everything or for what the filter shows", async ({
  app,
  page,
}) => {
  const chooser = page.waitForEvent("filechooser");
  await app.run("window.__app.commands.run('file.importSvd')");
  await (await chooser).setFiles({
    name: "demo.svd",
    mimeType: "application/xml",
    buffer: Buffer.from(SVD),
  });
  const dialog = page.locator(".modal", { hasText: "Import from DEMO" });
  const toggle = dialog.locator(".svd-all");
  const count = dialog.locator(".svd-count");
  await expect(toggle).toHaveText("Unselect all");

  // with a filter, it only acts on the matching registers
  await dialog.locator(".svd-search").fill("data");
  await expect(toggle).toHaveText("Unselect all matching");
  await toggle.click();
  await expect(count).toHaveText("1 register selected");
  await expect(toggle).toHaveText("Select all matching");

  await dialog.locator(".svd-search").fill("");
  await expect(toggle).toHaveText("Select all");
  await toggle.click();
  await expect(count).toHaveText("2 registers selected");
  await expect(toggle).toHaveText("Unselect all");
  await toggle.click();
  await expect(count).toHaveText("1 peripherals · 2 registers");
  await expect(
    dialog.getByRole("button", { name: "Add value" }),
  ).toBeDisabled();
});

const ARRAY_SVD = `<?xml version="1.0" encoding="utf-8"?>
<device>
  <name>BIG</name>
  <peripherals>
    <peripheral>
      <name>UART0</name>
      <baseAddress>0x40001000</baseAddress>
      <registers>
        <register><name>CTRL</name><addressOffset>0x0</addressOffset></register>
        <register>
          <name>BUF%s</name><dim>100000</dim><dimIncrement>4</dimIncrement>
          <addressOffset>0x10</addressOffset><resetValue>0x7</resetValue>
        </register>
      </registers>
    </peripheral>
  </peripherals>
</device>`;

test("a large register array is one row; its copies are picked by position", async ({
  app,
  page,
}) => {
  const chooser = page.waitForEvent("filechooser");
  await app.run("window.__app.commands.run('file.importSvd')");
  await (await chooser).setFiles({
    name: "big.svd",
    mimeType: "application/xml",
    buffer: Buffer.from(ARRAY_SVD),
  });
  const dialog = page.locator(".modal", { hasText: "Import from BIG" });
  const count = dialog.locator(".svd-count");
  await expect(count).toHaveText("100,001 registers selected");
  await dialog.locator(".svd-all").click();
  await expect(count).toHaveText("1 peripherals · 100,001 registers");

  await dialog.locator(".svd-periph").click();
  const array = dialog.locator(".svd-array");
  await expect(array).toContainText("BUF[0-99999]");
  await expect(array).toContainText("100,000 copies");

  // a bad position is marked and not applied
  const positions = array.locator(".svd-positions");
  await positions.fill("5-1");
  await expect(positions).toHaveClass(/invalid/);
  await positions.fill("1-2");
  await positions.press("Enter");
  await expect(count).toHaveText("2 registers selected");

  // opening the array lists its first copies, ticked as picked
  await dialog.locator(".svd-array b").click();
  await expect(dialog.locator(".svd-copy")).toHaveCount(398);
  await expect(
    dialog.getByRole("checkbox", { name: "Select UART0.BUF1", exact: true }),
  ).toBeChecked();
  await expect(
    dialog.getByRole("checkbox", { name: "Select UART0.BUF3", exact: true }),
  ).not.toBeChecked();
  await expect(dialog.locator(".svd-more")).toContainText(
    "99,602 more copies aren't listed",
  );

  await dialog.getByRole("button", { name: "Add 2 values" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".card")).toHaveCount(3);
  expect(
    await app.run("window.__app.cards.slice(1).map(c => c.model.name).join()"),
  ).toBe("UART0.BUF1,UART0.BUF2");
  expect(await app.value(2)).toBe("7");
});
