// End-to-end checks for bugs found in the October 2026 review.
import { expect, test } from "./helpers";

test("an interrupted Alt+drag still ends the undo step", async ({
  app,
  page,
}) => {
  const box = (await app.bit(5).boundingBox())!;
  await page.keyboard.down("Alt");
  await page.mouse.move(box.x + 5, box.y + 5);
  await page.mouse.down();
  await page.keyboard.up("Alt");
  // e.g. Alt+Tab mid-stroke: the browser cancels the pointer, no pointerup comes
  await page.evaluate(() =>
    document.dispatchEvent(
      new PointerEvent("pointercancel", { bubbles: true }),
    ),
  );
  expect(await app.run("window.__app.history.holds")).toBe(0);
  expect(await app.value()).toBe("20");
  await page.waitForTimeout(50); // let the stroke become its own undo step
  await app.setValue("0xabc");
  await expect(page).toHaveTitle(/•/); // unsaved changes are noticed again
  await page.keyboard.press("Control+z");
  expect(await app.value()).toBe("20"); // back to just the painted bit
});

test("Esc closes only the top dialog and asks before discarding edits", async ({
  app,
  page,
}) => {
  await app.run("window.__app.cards[0].exportCode()");
  await page
    .locator(".export-templates .btn[aria-label='New template']")
    .click();
  const source = page.locator(".tpl-source");
  await source.press("End");
  await page.keyboard.type("extra line");
  await page.keyboard.press("Escape");
  const discard = page.locator(".modal", { hasText: "Discard changes?" });
  await expect(discard).toBeVisible();
  await page.keyboard.press("Escape"); // = keep editing
  await expect(discard).toHaveCount(0);
  await expect(source).toBeVisible();
  await page.keyboard.press("Escape");
  await discard.getByRole("button", { name: "Discard" }).click();
  await expect(source).toHaveCount(0);
  // the export dialog underneath is still open
  await expect(page.locator(".modal")).toHaveCount(1);
  await expect(page.locator(".modal h2")).toContainText("Export code");
});

test("read-only fields ask before operations and typing change them", async ({
  app,
  page,
}) => {
  await app.run(`(() => {
    const model = window.__app.cards[0].model;
    model.setGroupDetails(model.addGroup(0, 3, "STATUS"), { access: "ro" });
  })()`);
  const not = app.card().locator(".ops .seg-btn", { hasText: "NOT" });
  const question = page.locator(".modal", {
    hasText: "Change a read-only field?",
  });

  await not.click();
  await expect(question).toBeVisible();
  await question.getByRole("button", { name: "Cancel" }).click();
  expect(await app.value()).toBe("0");

  // typing: one question, then the rest of the typing goes through
  const field = app.card().locator(".value-edit");
  await field.click();
  await field.press("Control+a");
  await field.pressSequentially("1");
  await expect(question).toBeVisible();
  await question.getByRole("button", { name: "Change it" }).click();
  await expect(field).toBeFocused();
  await field.pressSequentially("2");
  await expect(question).toHaveCount(0);
  expect(await app.value()).toBe("12");

  // "Allow for this field" stops the questions
  await app.card().locator(".card-head .name-edit").click();
  await not.click();
  await question.getByRole("button", { name: "Allow for this field" }).click();
  expect(await app.value()).toBe("ffffffed");
  await not.click();
  await expect(question).toHaveCount(0);
  expect(await app.value()).toBe("12");
});

test("What's new is in the Help menu", async ({ app, page }) => {
  await expect(app.card()).toBeVisible();
  await page.locator(".menubar-item", { hasText: "Help" }).click();
  await expect(
    page.locator(".menu-item", { hasText: "What's new" }),
  ).toBeVisible();
});

test("cancelling a wider template leaves the width alone", async ({
  app,
  page,
}) => {
  await app.run(`(() => {
    const model = window.__app.cards[0].model;
    model.setWidth(16);
    model.addGroup(0, 3, "LOW");
  })()`);
  await app.run("void window.__app.cards[0].applyTemplate()");
  await page.locator(".modal .tpl-item", { hasText: "float64" }).dblclick();
  await page.getByRole("button", { name: "Widen to 64 bits" }).click();
  await page
    .locator(".modal", { hasText: "Replace fields?" })
    .getByRole("button", { name: "Cancel" })
    .click();
  expect(await app.run("window.__app.cards[0].model.width")).toBe(16);
});

test("a file from a newer format version asks before opening", async ({
  app,
  page,
}) => {
  await app.run(
    `void window.__app.document.loadText(JSON.stringify({ app: "bitviewer", version: 99, values: [] }), null, "new.bitview")`,
  );
  const question = page.locator(".modal", {
    hasText: "Saved by a newer version",
  });
  await expect(question).toBeVisible();
  await question.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator(".card")).toHaveCount(1); // the workspace is untouched
});

test("a submenu without room on the right opens left of its menu, not over it", async ({
  app,
  page,
}) => {
  // the card's "More" menu sits at the right edge of the window
  await app.card().locator(".more-btn").click();
  // submenu rows open on hover; Playwright never sees them as "stable", so force the click
  await page
    .getByRole("menuitem", { name: "Snapshots ›" })
    .click({ force: true });
  const menus = page.locator(".menu");
  await expect(menus).toHaveCount(2);
  const parent = (await menus.nth(0).boundingBox())!;
  const submenu = (await menus.nth(1).boundingBox())!;
  expect(submenu.x + submenu.width).toBeLessThanOrEqual(parent.x);
});
