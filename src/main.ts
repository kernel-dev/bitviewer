import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";
import { App } from "./app";
import { installMenus, installTooltips } from "./ui";

installTooltips();
installMenus();

import { S } from "./settings";

const app = new App(document.getElementById("app")!);
S.load().then(() => app.start());
if (import.meta.env.DEV) (window as any).__app = app; // for scripted UI checks
