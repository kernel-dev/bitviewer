// Dragging a value by its handle to reorder the workspace. A line shows where
// it will land; the workspace scrolls while the pointer rests near its top or
// bottom edge; Esc, a lost pointer or leaving the window cancels.

import type { ValueCard } from "../../card/card";
import { moveItem } from "../../core/workspace";
import { html } from "../../ui/kit";
import { play } from "../../ui/sound";
import type { Workspace } from "./workspace";

export function dragCard(
  workspace: Workspace,
  card: ValueCard,
  event: PointerEvent,
) {
  event.preventDefault();
  if (workspace.cards.length < 2) return;
  const scroller = workspace.element;
  const from = workspace.cards.indexOf(card);
  let target = from;
  let lastY = event.clientY;
  const line = html("div", { class: "drop-line" });
  card.root.classList.add("dragging");
  document.body.classList.add("reordering");

  const place = () => {
    let index = 0;

    for (const card of workspace.cards) {
      // a collapsed peripheral's registers aren't laid out: use its header
      const shown = card.root.offsetParent
        ? card.root
        : (card.root.closest(".periph") ?? card.root);
      const rect = shown.getBoundingClientRect();
      if (lastY > rect.top + rect.height / 2) index++;
    }

    target = index;
    const before = workspace.cards[index]?.root;
    if (before?.parentElement) before.parentElement.insertBefore(line, before);
    else scroller.append(line);
  };

  // keep scrolling while the pointer rests near the top or bottom edge
  const autoScroll = window.setInterval(() => {
    const rect = scroller.getBoundingClientRect();
    const edge = 48;
    const scrollStep =
      lastY < rect.top + edge ? -14 : lastY > rect.bottom - edge ? 14 : 0;

    if (scrollStep) {
      scroller.scrollTop += scrollStep;
      place();
    }
  }, 16);

  const onPointerMove = (pointerEvent: PointerEvent) => {
    lastY = pointerEvent.clientY;
    place();
  };

  const finishDrag = (commit: boolean) => {
    window.clearInterval(autoScroll);
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
    document.removeEventListener("pointercancel", cancel);
    document.removeEventListener("keydown", onEscape, true);
    window.removeEventListener("blur", cancel);
    line.remove();
    card.root.classList.remove("dragging");
    document.body.classList.remove("reordering");
    const destination = target > from ? target - 1 : target;
    const reordered = moveItem(
      workspace.cards,
      from,
      destination,
      workspace.blockOf,
    );

    if (
      commit &&
      reordered.some((item, index) => item !== workspace.cards[index])
    ) {
      workspace.reorder(reordered);
      play("toggle");
    }
  };

  const onPointerUp = () => finishDrag(true);
  const cancel = () => finishDrag(false);

  const onEscape = (keyEvent: KeyboardEvent) => {
    if (keyEvent.key === "Escape") {
      keyEvent.stopPropagation();
      finishDrag(false);
    }
  };

  document.addEventListener("pointermove", onPointerMove);
  document.addEventListener("pointerup", onPointerUp);
  document.addEventListener("pointercancel", cancel);
  document.addEventListener("keydown", onEscape, true);
  window.addEventListener("blur", cancel);
  place();
}
