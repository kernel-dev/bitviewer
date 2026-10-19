import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";
import { App } from "./app";
import { installMenus, installTooltips } from "./ui";

installTooltips();
installMenus();
const app = new App(document.getElementById("app")!);
app.start();
if (import.meta.env.DEV) (window as any).__app = app; // for scripted UI checks
