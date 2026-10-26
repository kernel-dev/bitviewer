// Auto-updates through Tauri's updater: signed installers and a latest.json
// published with each GitHub release (see `npm run release` in the README).
import { CloudDownload } from "lucide";
import { ask, button, html, modal, toast } from "../ui/kit";
import { isTauri } from "./platform";

/** Checks for a newer version. `manual` reports "up to date" and errors; the
 *  start-up check stays silent unless an update exists. `prepare` runs before
 *  installing (the app closes during the install): it asks about unsaved work
 *  and writes the session; false cancels the install. */
export async function checkForUpdates(
  manual: boolean,
  prepare: () => Promise<boolean>,
): Promise<void> {
  if (!isTauri) {
    if (manual) toast("Updates are only available in the desktop app");
    return;
  }
  let update: Awaited<
    ReturnType<typeof import("@tauri-apps/plugin-updater").check>
  >;
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    if (manual) toast("Checking for updates…");
    update = await check();
  } catch (error) {
    if (manual) {
      await ask(
        "Couldn't check for updates",
        `${error instanceof Error ? error.message : String(error)}\n\nIf no release has been published yet, this is expected.`,
        [{ id: "ok", label: "OK", className: "primary" }],
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
        html("p", { class: "modal-text" }, `You have ${found.currentVersion}.`),
        found.body
          ? html("pre", { class: "code-preview release-notes" }, found.body)
          : "",
      );
      return [
        button({ label: "Later", onClick: () => close(false) }),
        button({
          label: "Install and restart",
          className: "primary",
          onClick: () => close(true),
        }),
      ];
    },
  });
  if (!install || !(await prepare())) return;
  let downloadedBytes = 0;
  let total = 0;
  try {
    await found.downloadAndInstall((event) => {
      if (event.event === "Started") total = event.data.contentLength ?? 0;
      else if (event.event === "Progress") {
        downloadedBytes += event.data.chunkLength;
        if (total)
          toast(
            `Downloading update… ${Math.round((downloadedBytes / total) * 100)}%`,
          );
      } else if (event.event === "Finished") toast("Installing…");
    });
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (error) {
    toast(
      `Update failed: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}
