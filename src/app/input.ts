// Window-wide input: Ctrl+wheel zoom, keyboard shortcuts, which value is
// active, undo-step boundaries, clearing the selection by clicking elsewhere,
// and the right-click menu.

import { menusOpen, modalOpen } from "../ui/kit";
import type { App } from "./app";
import { paletteOpen } from "./palette";
import { tourRunning } from "./tour";
import { zoomBy } from "./view";

/** Inputs, text areas and editable regions: they keep the native right-click menu and their own Esc. */
const isTextField = (target: EventTarget | null) =>
  target instanceof HTMLInputElement ||
  target instanceof HTMLTextAreaElement ||
  (target instanceof HTMLElement && target.isContentEditable);

export function installInput(app: App) {
  const workspace = app.workspace;

  let wheelAcc = 0;
  window.addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      wheelAcc += -event.deltaY;
      while (wheelAcc >= 100) {
        wheelAcc -= 100;
        zoomBy(1);
      }
      while (wheelAcc <= -100) {
        wheelAcc += 100;
        zoomBy(-1);
      }
    },
    { passive: false },
  );

  const track = (event: Event) => {
    const card = workspace.cards.find((candidate) =>
      candidate.root.contains(event.target as Node),
    );
    if (card) workspace.activeCard = card;
  };
  document.addEventListener("pointerdown", track, true);
  // Record any pending undo step before the next edit starts, so that a bit
  // click followed instantly by typing (or the reverse) stays two steps.
  // Capture-phase listeners run before the field's or strip's own handlers.
  document.addEventListener("input", () => app.history.flush(), true);
  document.addEventListener("pointerdown", () => app.history.flush(), true);
  document.addEventListener("focusin", track);

  document.addEventListener("keydown", (event) => {
    if (modalOpen() || menusOpen() || paletteOpen() || tourRunning()) return;
    // Esc inside a field reverts that field instead of clearing the selection
    if (event.key === "Escape" && isTextField(document.activeElement)) return;
    app.commands.handleKey(event);
  });

  // Clicking anywhere that isn't part of selecting drops the selection.
  document.addEventListener("pointerdown", (event) => {
    if (!workspace.cards.some((card) => card.selection)) return;
    const target = event.target as Element;
    if (target.closest(".bit, .row-label, .menu, .backdrop, [data-keep-sel]"))
      return;
    // clicks on a scrollbar land on the scrolling element itself
    if (
      target instanceof HTMLElement &&
      (event.offsetX >= target.clientWidth ||
        event.offsetY >= target.clientHeight)
    )
      return;
    workspace.clearSelections();
  });

  document.addEventListener("contextmenu", (event) => {
    // keep the native menu for text fields, suppress the browser one elsewhere
    if (!isTextField(event.target)) event.preventDefault();
  });
}
