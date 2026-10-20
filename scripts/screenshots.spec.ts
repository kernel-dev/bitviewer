// Takes the screenshots used by the guide (docs/guide). Run: npm run docs:shots
import { join } from "node:path";
import { test } from "../e2e/helpers";

const out = (name: string) => join(import.meta.dirname, "..", "docs", "guide", "img", `${name}.png`);

test("bits and selection", async ({ app }) => {
  await app.setValue("0x00C0FFEE");
  await app.run("window.__app.cards[0].setSelection(8, 15)");
  await app.card().screenshot({ path: out("bits-selection") });
});

test("expression bar", async ({ app }) => {
  await app.setValue("0x12345678");
  await app.card().locator(".expr-toggle").click();
  await app.card().locator(".expr-bar .expr-input").fill("(x & ~mask(8)) | 0xAB");
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
  await page.screenshot({ path: out("resize-field"), clip: { x: 0, y: 80, width: 1200, height: 560 } });
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
