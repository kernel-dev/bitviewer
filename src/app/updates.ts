// Auto-updates through Tauri's updater: signed installers and a latest.json
// published with each GitHub release (see `npm run release` in the README).
import { CloudDownload } from "lucide";
import { ask, button, h, modal, toast } from "../ui/kit";
import { isTauri } from "./platform";

/** Checks for a newer version. `manual` reports "up to date" and errors; the
 *  start-up check stays silent unless an update exists. */
export async function checkForUpdates(manual: boolean): Promise<void> {
  if (!isTauri) {
    if (manual) toast("Updates are only available in the desktop app");
    return;
  }
  let update: Awaited<ReturnType<typeof import("@tauri-apps/plugin-updater").check>>;
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    if (manual) toast("Checking for updates…");
    update = await check();
  } catch (e) {
    if (manual) {
      await ask(
        "Couldn't check for updates",
        `${e instanceof Error ? e.message : String(e)}\n\nIf no release has been published yet, this is expected.`,
        [{ id: "ok", label: "OK", cls: "primary" }],
        "ok",
      );
    }
    return;
  }
  if (!update) {
    if (manual) toast("You're on the latest version", "ok");
    return;
  }
  const found = update;
  const install = await modal<boolean>({
    title: `Bit Viewer ${found.version} is available`,
    icon: CloudDownload,
    cancelValue: false,
    build: (body, close) => {
      body.append(
        h("p", { class: "modal-text" }, `You have ${found.currentVersion}.`),
        found.body ? h("pre", { class: "code-preview release-notes" }, found.body) : "",
      );
      return [
        button({ label: "Later", onClick: () => close(false) }),
        button({ label: "Install and restart", cls: "primary", onClick: () => close(true) }),
      ];
    },
  });
  if (!install) return;
  let got = 0;
  let total = 0;
  try {
    await found.downloadAndInstall((ev) => {
      if (ev.event === "Started") total = ev.data.contentLength ?? 0;
      else if (ev.event === "Progress") {
        got += ev.data.chunkLength;
        if (total) toast(`Downloading update… ${Math.round((got / total) * 100)}%`);
      } else if (ev.event === "Finished") toast("Installing…");
    });
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (e) {
    toast(`Update failed: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}
