import { readFileSync } from "node:fs";
import {
  test as base,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";

const version: string = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
).version;

/** A fresh app per test: no first-run tour or what's-new dialog, a known theme, empty session. */
export const test = base.extend<{ app: AppDriver }>({
  app: async ({ page }, use) => {
    await page.addInitScript((appVersion) => {
      if (!sessionStorage.getItem("e2e-init")) {
        localStorage.clear();
        localStorage.setItem(
          "bitviewer.settings",
          JSON.stringify({
            theme: "dark",
            tour_done: true,
            last_seen_version: appVersion,
          }),
        );
        sessionStorage.setItem("e2e-init", "1");
      }
    }, version);

    await page.goto("/");
    await expect(page.locator(".card")).toHaveCount(1);
    await use(new AppDriver(page));
  },
});

export { expect };

export class AppDriver {
  constructor(readonly page: Page) {}

  card(cardIndex = 0): Locator {
    return this.page.locator(".card").nth(cardIndex);
  }

  bit(bitIndex: number, card = 0): Locator {
    return this.card(card).locator(
      `.strip:not(.cmp) .bit[data-bit="${bitIndex}"] .cell`,
    );
  }

  /** The model value of a card, as lower-case hex. */
  value(card = 0): Promise<string> {
    return this.page.evaluate(
      (cardIndex) =>
        (window as any).__app.cards[cardIndex].model.value.toString(16),
      card,
    );
  }

  setValue(value: string, card = 0): Promise<void> {
    return this.page.evaluate(
      ([cardIndex, hexValue]) =>
        (window as any).__app.cards[cardIndex].model.setValue(BigInt(hexValue)),
      [card, value] as const,
    );
  }

  run<T>(script: string): Promise<T> {
    return this.page.evaluate(script);
  }

  async drag(
    from: Locator,
    target: Locator,
    modifiers: ("Alt" | "Shift")[] = [],
  ) {
    const fromBox = await from.boundingBox();
    const toBox = await target.boundingBox();
    if (!fromBox || !toBox) throw new Error("not visible");
    for (const modifier of modifiers) await this.page.keyboard.down(modifier);
    await this.page.mouse.move(
      fromBox.x + fromBox.width / 2,
      fromBox.y + fromBox.height / 2,
    );
    await this.page.mouse.down();
    await this.page.mouse.move(
      toBox.x + toBox.width / 2,
      toBox.y + toBox.height / 2,
      { steps: 12 },
    );
    await this.page.mouse.up();
    for (const modifier of modifiers) await this.page.keyboard.up(modifier);
  }

  async menu(label: string) {
    await this.page.locator(".menu-item", { hasText: label }).first().click();
  }
}
