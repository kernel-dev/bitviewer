import { expect, test } from "./helpers";

// all three values fit without scrolling, so positions don't move mid-drag
test.use({ viewport: { width: 1400, height: 1300 } });

const names = (app: { run<T>(text: string): Promise<T> }) =>
  app.run<string>("window.__app.cards.map(c => c.model.name).join(', ')");

test.beforeEach(async ({ app, page }) => {
  await page.keyboard.press("Control+1");
  await page.keyboard.press("Control+1");
  await expect(page.locator(".card")).toHaveCount(3);
  await app.run(`["Alpha", "Beta", "Gamma"].forEach((n, i) => window.__app.cards[i].model.setName(n));
    window.__app.cards.forEach(c => c.rebuild())`);
});

test("drag a value by its handle to reorder, then undo", async ({
  app,
  page,
}) => {
  const grip = page.locator(".card").nth(2).locator(".grip");
  const target = page.locator(".card").nth(0).locator(".card-head");
  await grip.hover(); // waits until the handle is visible and stable
  await page.mouse.down();
  const box = (await target.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 2, { steps: 20 });
  await expect(page.locator(".drop-line")).toHaveCount(1);
  await page.mouse.up();
  expect(await names(app)).toBe("Gamma, Alpha, Beta");
  await page.keyboard.press("Control+z");
  expect(await names(app)).toBe("Alpha, Beta, Gamma");
});

test("collapse, search and the command palette", async ({ app, page }) => {
  await page.locator(".card").nth(0).locator(".collapse-btn").click();
  await expect(page.locator(".card").nth(0)).toHaveClass(/collapsed/);
  await expect(page.locator(".card").nth(0).locator(".strip")).toHaveCount(0);

  await page.keyboard.press("Control+f");
  await page.keyboard.type("bet");
  await page.keyboard.press("Enter");
  await expect(page.locator(".search-count")).toHaveText("1 of 3 values");
  await page.keyboard.press("Escape");
  await expect(page.locator(".card:visible")).toHaveCount(3);

  await page.locator(".card").nth(1).locator(".value-edit").click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+k");
  await page.keyboard.type("snapshot");
  await expect(page.locator(".palette-item.active .palette-label")).toHaveText(
    "Take snapshot… — Beta",
  );
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  expect(await app.run("window.__app.cards[1].model.snapshots.length")).toBe(1);
});

test("unsaved work comes back after a reload", async ({ app, page }) => {
  await app.setValue("0xabc", 1);
  // wait for the auto-saved session to contain the change (it's written ~1 s after edits)
  await page.waitForFunction(() =>
    (localStorage.getItem("bitviewer.app.data.session.json") ?? "").includes(
      '"0xABC"',
    ),
  );
  await page.reload();
  await expect(page.locator(".card")).toHaveCount(3);
  expect(await names(app)).toBe("Alpha, Beta, Gamma");
  expect(await app.value(1)).toBe("abc");
  await expect(page.locator(".toast")).toContainText(
    "Restored unsaved changes",
  );
});

test("search runs on Enter or the Search button, not while typing", async ({
  page,
}) => {
  await page.keyboard.press("Control+f");
  await page.keyboard.type("gam");
  await expect(page.locator(".search-count")).toHaveText(
    "Press Enter to search",
  );
  await expect(page.locator(".card:visible")).toHaveCount(3);
  await page
    .locator(".search-bar")
    .getByRole("button", { name: "Search" })
    .click();
  await expect(page.locator(".card:visible")).toHaveCount(1);
  await expect(page.locator(".search-count")).toHaveText("1 of 3 values");
  // new text waits for Enter again; an emptied box shows everything at once
  await page.locator(".search-input").fill("alp");
  await expect(page.locator(".card:visible")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(page.locator(".card:visible")).toHaveCount(1);
  expect(await page.locator(".card:visible .name-edit").inputValue()).toBe(
    "Alpha",
  );
  await page.locator(".search-input").fill("");
  await expect(page.locator(".card:visible")).toHaveCount(3);
});

test("compare with a typed value, or with another value picked from a list", async ({
  app,
  page,
}) => {
  await app.setValue("0xff", 0);
  await app.setValue("0x0f", 2);
  const card = page.locator(".card").nth(0);
  await card.locator(".more-btn").click();
  await app.menu("Compare with…");
  const dialog = page.locator(".modal", { hasText: "Compare “Alpha” with…" });
  // typed: an expression where x is the value itself
  await dialog.locator(".expr-input").fill("x ^ 0b11");
  await dialog.getByRole("button", { name: "Compare" }).click();
  await expect(dialog).toHaveCount(0);
  expect(
    await app.run("window.__app.cards[0].model.compareValue(0).toString(16)"),
  ).toBe("fc");

  // picked: the other values are listed (filterable) in a collapsed section
  await card.locator(".more-btn").click();
  await app.menu("Compare with…");
  await dialog.locator(".compare-pick summary").click();
  await dialog.locator(".compare-filter").fill("gam");
  await expect(dialog.locator(".compare-item")).toHaveCount(1);
  await dialog.locator(".compare-item").dblclick();
  await expect(dialog).toHaveCount(0);
  expect(
    await app.run("window.__app.cards[0].model.compareValue(0).toString(16)"),
  ).toBe("f");
});
