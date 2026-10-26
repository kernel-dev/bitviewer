import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./ui/styles/index.css";
import { App } from "./app/app";
import { appSettings } from "./platform/settings";
import { html, installMenus, installTooltips, toast } from "./ui/kit";

installTooltips();
installMenus();

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

// Anything nobody caught: keep working, but say that something went wrong.
window.addEventListener("error", (event) => {
  toast(
    `Something went wrong: ${message(event.error ?? event.message)}`,
    "error",
  );
});

window.addEventListener("unhandledrejection", (event) => {
  toast(`Something went wrong: ${message(event.reason)}`, "error");
});

const root = document.getElementById("app")!;
const app = new App(root);

appSettings
  .load()
  .then(() => app.start())
  .catch((error) => {
    console.error(error);
    // without this the window would just stay blank
    root.replaceChildren(
      html(
        "div",
        { class: "empty startup-error" },
        html("h3", {}, "Bit Viewer couldn't start"),
        html("p", { class: "muted" }, message(error)),
        html(
          "p",
          { class: "muted small" },
          "Your settings and auto-saved work are untouched. Try restarting the app; if this keeps happening, please report it with the message above.",
        ),
      ),
    );
  });

if (import.meta.env.DEV) (window as any).__app = app; // for scripted UI checks
