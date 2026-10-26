import { defineConfig } from "@playwright/test";

// End-to-end tests drive the real UI against the Vite dev server: locally in
// the installed Microsoft Edge (no browser download needed), in CI in
// Playwright's Chromium (`npx playwright install chromium`).
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:4173",
    channel: process.env.CI ? undefined : "msedge",
    viewport: { width: 1400, height: 900 },
  },
  webServer: {
    command: "npx vite --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
