import { defineConfig } from "@playwright/test";

// End-to-end tests drive the real UI in the installed Microsoft Edge
// (no browser download needed) against the Vite dev server.
export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:4173",
    channel: "msedge",
    viewport: { width: 1400, height: 900 },
  },
  webServer: {
    command: "npx vite --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
