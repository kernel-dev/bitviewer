import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./ui/styles.css";
import { App } from "./app/app";
import { installMenus, installTooltips } from "./ui/kit";

installTooltips();
installMenus();

import { S } from "./app/settings";

const app = new App(document.getElementById("app")!);
S.load().then(() => app.start());
if (import.meta.env.DEV) (window as any).__app = app; // for scripted UI checks
