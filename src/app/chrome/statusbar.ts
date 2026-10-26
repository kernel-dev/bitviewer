// The status bar: a hint line and the zoom controls.

import { Minus, Plus } from "lucide";
import { appSettings } from "../../platform/settings";
import { button, html } from "../../ui/kit";
import { zoomBy } from "../view";

export class Statusbar {
  readonly element: HTMLElement;
  private zoomLabel: HTMLElement;

  constructor() {
    this.zoomLabel = html("button", {
      type: "button",
      class: "zoom-label",
      tip: "Reset zoom (Ctrl+0)",
      onClick: () => appSettings.set("zoom", 1),
    });
    this.updateZoom();
    this.element = html(
      "footer",
      { class: "statusbar" },
      html(
        "span",
        { class: "status-hint" },
        "Click a bit to flip · drag to select · right-click for row actions · F1 for help",
      ),
      html("div", { class: "spacer" }),
      html(
        "div",
        { class: "zoom" },
        button({
          icon: Minus,
          className: "ghost xs",
          tip: "Zoom out (Ctrl+-)",
          onClick: () => zoomBy(-1),
          size: 13,
        }),
        this.zoomLabel,
        button({
          icon: Plus,
          className: "ghost xs",
          tip: "Zoom in (Ctrl+=)",
          onClick: () => zoomBy(1),
          size: 13,
        }),
      ),
    );
  }

  updateZoom() {
    this.zoomLabel.textContent = `${Math.round(appSettings.get("zoom") * 100)}%`;
  }
}
