import { defineConfig } from "vitest/config";

// Unit tests are tests/unit; tests/e2e and tests/docs belong to Playwright.
export default defineConfig({
  test: { include: ["tests/unit/**/*.test.ts"] },
});
