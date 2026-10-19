import { test as base, expect, type Locator, type Page } from "@playwright/test";

/** A fresh app per test: no first-run tour, a known theme, empty session. */
export const test = base.extend<{ app: AppDriver }>({
  app: async ({ page }, use) => {
    await page.addInitScript(() => {
      if (!sessionStorage.getItem("e2e-init")) {
        localStorage.clear();
        localStorage.setItem("bitviewer.settings", JSON.stringify({ theme: "dark", tour_done: true }));
        sessionStorage.setItem("e2e-init", "1");
      }
    });
    await page.goto("/");
    await expect(page.locator(".card")).toHaveCount(1);
    await use(new AppDriver(page));
  },
});
export { expect };

export class AppDriver {
  constructor(readonly page: Page) {}

  card(i = 0): Locator {
    return this.page.locator(".card").nth(i);
  }

  bit(n: number, card = 0): Locator {
    return this.card(card).locator(`.strip:not(.cmp) .bit[data-bit="${n}"] .cell`);
  }

  /** The model value of a card, as lower-case hex. */
  value(card = 0): Promise<string> {
    return this.page.evaluate((i) => (window as any).__app.cards[i].model.value.toString(16), card);
  }

  setValue(v: string, card = 0): Promise<void> {
    return this.page.evaluate(([i, x]) => (window as any).__app.cards[i].model.setValue(BigInt(x)), [card, v] as const);
  }

  run<T>(fn: string): Promise<T> {
    return this.page.evaluate(fn);
  }

  async drag(from: Locator, to: Locator, modifiers: ("Alt" | "Shift")[] = []) {
    const a = await from.boundingBox();
    const b = await to.boundingBox();
    if (!a || !b) throw new Error("not visible");
    for (const m of modifiers) await this.page.keyboard.down(m);
    await this.page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await this.page.mouse.down();
    await this.page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
    await this.page.mouse.up();
    for (const m of modifiers) await this.page.keyboard.up(m);
  }

  async menu(label: string) {
    await this.page.locator(".menu-item", { hasText: label }).first().click();
  }
}
