import { expect, test } from "./helpers";

// Large workspaces: only values on or near the screen are built.
test("only values near the screen are built, others as you get to them", async ({
  app,
  page,
}) => {
  await app.run(`(() => {
    const values = Array.from({ length: 300 }, (_, i) => ({
      name: "REG" + i,
      width: 32,
      value: "0x" + i.toString(16),
      groups: [{ lo: 0, hi: 3, name: "LOW" }],
    }));
    return window.__app.document.loadText(
      JSON.stringify({ app: "bitviewer", version: 1, values }),
      null,
      "big.bitview",
      true,
    );
  })()`);
  await expect(page.locator(".card")).toHaveCount(300);
  const built = () =>
    app.run<number>("window.__app.cards.filter((card) => card.built).length");
  expect(await built()).toBeLessThan(20);
  expect(await page.locator(".bit").count()).toBeLessThan(20 * 32 * 2);

  // a search shows the match, built
  await page.keyboard.press("Control+f");
  await page.keyboard.type("REG299");
  await page.keyboard.press("Enter");
  const last = page.locator(".card").nth(299);
  await expect(last.locator(".name-edit")).toHaveValue("REG299");
  await expect(last).toBeInViewport();
  await page.keyboard.press("Escape");

  // scrolling to the end builds what comes into view
  await app.run("window.__app.workspace.element.scrollTop = 1e9");
  await expect(last.locator(".name-edit")).toHaveValue("REG299");
  await expect(last).toBeInViewport();
  expect(await built()).toBeLessThan(40);

  // a change to a value far away shows once it is built
  await app.run("window.__app.cards[0].model.setValue(0xabcn)");
  await app.run("window.__app.workspace.element.scrollTop = 0");
  await expect(page.locator(".card").nth(0).locator(".value-edit")).toHaveValue(
    "0000_0ABC",
  );
});
