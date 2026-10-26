import { expect, test } from "./helpers";

test("a bit click and typing right after are two undo steps", async ({
  app,
  page,
}) => {
  // dispatch both edits in the same task, so no timer can run in between
  await page.evaluate(() => {
    const cell = document.querySelector(
      '.strip:not(.cmp) .bit[data-bit="0"] .cell',
    ) as HTMLElement;
    const rect = cell.getBoundingClientRect();
    const pointerInit = {
      clientX: rect.x + 5,
      clientY: rect.y + 5,
      bubbles: true,
      button: 0,
      buttons: 1,
      pointerId: 1,
    };
    cell.dispatchEvent(new PointerEvent("pointerdown", pointerInit));
    cell.dispatchEvent(
      new PointerEvent("pointerup", { ...pointerInit, buttons: 0 }),
    );
    const field = document.querySelector(".value-edit") as HTMLInputElement;
    field.focus();
    field.value = "ABCD";
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });

  expect(await app.value()).toBe("abcd");
  await page.locator(".value-edit").blur();
  await page.keyboard.press("Control+z");
  expect(await app.value()).toBe("1");
  await page.keyboard.press("Control+z");
  expect(await app.value()).toBe("0");
});
