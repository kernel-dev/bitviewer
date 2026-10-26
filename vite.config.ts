import { defineConfig } from "vite";

// https://v2.tauri.app/start/frontend/vite/
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**", "**/*.bitview.json", "**/*.tmp"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: { target: "chrome110", sourcemap: false },
});
