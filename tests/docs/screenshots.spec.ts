// Takes the screenshots used by the guide (docs/guide). Run: npm run docs:shots
import { join } from "node:path";
import { test } from "../e2e/helpers";

const out = (name: string) =>
  join(import.meta.dirname, "..", "..", "docs", "guide", "img", `${name}.png`);

test("bits and selection", async ({ app }) => {
  await app.setValue("0x00C0FFEE");
  await app.run("window.__app.cards[0].setSelection(8, 15)");
  await app.card().screenshot({ path: out("bits-selection") });
});

test("expression bar", async ({ app }) => {
  await app.setValue("0x12345678");
  await app.card().locator(".expr-toggle").click();
  await app
    .card()
    .locator(".expr-bar .expr-input")
    .fill("(x & ~mask(8)) | 0xAB");
  await app.card().screenshot({ path: out("expr-bar") });
});

test("register fields", async ({ app }) => {
  await app.setValue("0x8A5C3F20");
  await app.run(`(() => {
    const m = window.__app.cards[0].model;
    m.addGroup(28, 31, "MODE");
    m.addGroup(16, 27, "COUNT");
    m.addGroup(4, 7, "FCD");
  })()`);
  await app.card().screenshot({ path: out("fields") });
});

test("resize a field", async ({ app, page }) => {
  await app.setValue("0x8A5C3F20");
  await app.run(`(() => {
    const m = window.__app.cards[0].model;
    m.addGroup(28, 31, "MODE");
    m.addGroup(4, 7, "FCD");
    window.__app.cards[0].setSelection(4, 11);
  })()`);
  await app.bit(5).click({ button: "right" });
  await page.locator(".menu-item", { hasText: "Resize" }).waitFor();
  await page.waitForTimeout(400); // let the menu finish fading in
  await page.screenshot({
    path: out("resize-field"),
    clip: { x: 0, y: 80, width: 1200, height: 560 },
  });
});

test("operations menu", async ({ app, page }) => {
  await app.setValue("0x12345678");
  await app.card().locator(".more-ops").click();
  await page.screenshot({ path: out("operations") });
});

test("compare row", async ({ app }) => {
  await app.setValue("0x12345678");
  await app.run("window.__app.cards[0].model.addCompare(0)");
  await app.run("window.__app.cards[0].model.setCompare(0, 0x12345679n)");
  await app.card().screenshot({ path: out("compare") });
});

test("float32 template", async ({ app }) => {
  await app.run(`(() => {
    const m = window.__app.cards[0].model;
    m.setValue(0x40490fdbn);
    m.applyTemplate({ name: "IEEE-754 float32", width: 32, fields: [
      { lo: 31, hi: 31, name: "SIGN", color: "#f59f00", base: 2 },
      { lo: 23, hi: 30, name: "EXPONENT", color: "#2fb344", base: 10, formula: "x - 127" },
      { lo: 0, hi: 22, name: "FRACTION", color: "#ae3ec9", base: 16 },
    ] });
  })()`);
  await app.card().screenshot({ path: out("template") });
});

test("export code dialog", async ({ app, page }) => {
  await app.setValue("0x8A5C3F20");
  await app.run(`(() => {
    const m = window.__app.cards[0].model;
    m.setName("Ctrl");
    const mode = m.addGroup(28, 31, "MODE");
    m.setGroupDetails(mode, { named: [{ value: 0n, label: "Off" }, { value: 8n, label: "Auto" }] });
    m.addGroup(16, 27, "COUNT");
    m.addGroup(4, 7, "FCD");
    window.__app.cards[0].exportCode();
  })()`);
  await page.locator(".code-preview").waitFor();
  await page.waitForTimeout(400);
  await page
    .locator(".backdrop.show .modal")
    .last()
    .screenshot({ path: out("export-code") });
});

test("export code, wide register", async ({ app, page }) => {
  await app.run(`(() => {
    const m = window.__app.cards[0].model;
    m.setWidth(64);
    m.setName("Ctrl");
    m.setValue(0x1122334455667788n);
    m.addGroup(60, 63, "MODE");
    m.addGroup(28, 35, "COUNT");
    m.addGroup(4, 7, "FCD");
    window.__app.cards[0].exportCode();
  })()`);
  await page.locator(".modal .seg-btn", { hasText: "C struct" }).click();
  await page.waitForTimeout(400);
  await page
    .locator(".backdrop.show .modal")
    .last()
    .screenshot({ path: out("export-struct") });
});

test("export template editor", async ({ app, page }) => {
  await app.run(`(() => {
    const m = window.__app.cards[0].model;
    m.setName("Ctrl");
    m.setValue(0x8A5C3F20n);
    m.addGroup(28, 31, "MODE");
    m.addGroup(16, 27, "COUNT");
    m.addGroup(4, 7, "FCD");
    window.__app.cards[0].exportCode();
  })()`);
  await page
    .locator(".export-templates .btn[aria-label='New template']")
    .click();
  await page
    .locator(".tpl-source")
    .fill(
      [
        "@name Markdown table",
        "@ext md",
        "@about One table row per field.",
        "| Field | Bits | Width |",
        "|---|---|---|",
        "@for field in fields | reverse",
        "| ${field.name} | ${field.range} | ${field.width} |",
        "@end",
      ].join("\n"),
    );
  await page.waitForTimeout(400);
  await page
    .locator(".backdrop.show .modal")
    .last()
    .screenshot({ path: out("export-editor") });
});

// A made-up device, so the guide doesn't reproduce a vendor's file.
const DEMO_SVD = `<?xml version="1.0" encoding="utf-8"?>
<device>
  <name>DEMO-M4</name>
  <description>Example microcontroller</description>
  <size>32</size>
  <peripherals>
    <peripheral>
      <name>GPIOA</name><groupName>GPIO</groupName>
      <description>General-purpose I/O</description>
      <baseAddress>0x40020000</baseAddress>
      <registers>
        <register><name>MODER</name><description>Port mode</description><addressOffset>0x0</addressOffset><resetValue>0xA8000000</resetValue>
          <fields><field><name>MODER15</name><bitRange>[31:30]</bitRange></field><field><name>MODER14</name><bitRange>[29:28]</bitRange></field></fields></register>
        <register><name>IDR</name><description>Input data</description><addressOffset>0x10</addressOffset><access>read-only</access></register>
        <register><name>ODR</name><description>Output data</description><addressOffset>0x14</addressOffset></register>
      </registers>
    </peripheral>
    <peripheral derivedFrom="GPIOA"><name>GPIOB</name><baseAddress>0x40020400</baseAddress></peripheral>
    <peripheral>
      <name>UART0</name><groupName>UART</groupName>
      <description>Serial port</description>
      <baseAddress>0x40011000</baseAddress>
      <registers>
        <register><name>CTRL</name><description>Control</description><addressOffset>0x0</addressOffset><resetValue>0x301</resetValue>
          <fields>
            <field><name>EN</name><description>Enable</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth></field>
            <field><name>MODE</name><bitRange>[9:8]</bitRange><enumeratedValues>
              <enumeratedValue><name>Off</name><value>0</value></enumeratedValue>
              <enumeratedValue><name>Fast</name><value>3</value></enumeratedValue></enumeratedValues></field>
            <field><name>BUSY</name><bitOffset>31</bitOffset><bitWidth>1</bitWidth><access>read-only</access></field>
          </fields></register>
        <register><name>BAUD</name><description>Baud rate divider</description><addressOffset>0x4</addressOffset><size>16</size><resetValue>0x683</resetValue></register>
        <register><name>DATA</name><description>Data</description><addressOffset>0x8</addressOffset><size>8</size></register>
      </registers>
    </peripheral>
  </peripherals>
</device>`;

test("svd import", async ({ app, page }) => {
  const chooser = page.waitForEvent("filechooser");
  await app.run("window.__app.commands.run('file.importSvd')");
  await (await chooser).setFiles({
    name: "demo-m4.svd",
    mimeType: "application/xml",
    buffer: Buffer.from(DEMO_SVD),
  });
  const dialog = page.locator(".modal", { hasText: "Import from DEMO-M4" });
  await dialog.locator(".svd-periph", { hasText: "UART0" }).click();
  await dialog
    .locator(".svd-reg", { hasText: "CTRL" })
    .locator("input")
    .check();
  await dialog
    .locator(".svd-reg", { hasText: "BAUD" })
    .locator("input")
    .check();
  await page.waitForTimeout(300); // let the dialog finish fading in
  await dialog.screenshot({ path: out("svd-import") });
});

test("peripheral", async ({ app, page }) => {
  const chooser = page.waitForEvent("filechooser");
  await app.run("window.__app.commands.run('file.importSvd')");
  await (await chooser).setFiles({
    name: "demo-m4.svd",
    mimeType: "application/xml",
    buffer: Buffer.from(DEMO_SVD),
  });
  const dialog = page.locator(".modal", { hasText: "Import from DEMO-M4" });
  await dialog
    .locator(".svd-periph", { hasText: "UART0" })
    .locator("input")
    .check();
  await dialog.getByRole("button", { name: /Add/ }).last().click();
  // the UART's registers, folded to their header lines, without the starting value
  await app.run(`(() => {
    const app = window.__app;
    app.removeValue(app.cards[0]);
    app.cards.forEach((card) => card.model.setCollapsed(true));
  })()`);
  await page.waitForTimeout(400);
  await page.locator(".periph").screenshot({ path: out("peripheral") });
});
