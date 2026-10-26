import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Regenerates the screenshots in docs/guide/img: npm run docs:shots
export default defineConfig({
  ...base,
  testDir: "tests/docs",
  testMatch: "screenshots.spec.ts",
  fullyParallel: false,
  workers: 1,
  use: {
    ...base.use,
    viewport: { width: 1200, height: 1200 },
    deviceScaleFactor: 2,
  },
});
