// Keyboard control of a card's bits: arrows move the cursor (Shift+arrows
// select), Home / End jump to the ends, Space or Enter flips, 0 / 1 set.

import { appSettings } from "../platform/settings";
import { play } from "../ui/sound";
import type { ValueCard } from "./card";

export function onBitKey(card: ValueCard, event: KeyboardEvent) {
  const model = card.model;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const current = card.cursor ?? model.width - 1;
  const left = appSettings.get("msb_left") ? 1 : -1; // moving left goes to a higher bit when the MSB is on the left
  const moves: Record<string, number> = {
    ArrowLeft: left,
    ArrowRight: -left,
    ArrowUp: verticalStep(card),
    ArrowDown: -verticalStep(card),
  };
  let next: number | null = null;
  if (event.key in moves) next = current + moves[event.key];
  else if (event.key === "Home") next = model.width - 1;
  else if (event.key === "End") next = 0;
  if (next !== null) {
    event.preventDefault();
    // up/down past the first/last line stays put; left/right stop at the ends
    const vertical = event.key === "ArrowUp" || event.key === "ArrowDown";
    if (vertical && (next < 0 || next >= model.width)) next = current;
    next = Math.max(0, Math.min(model.width - 1, next));
    if (event.shiftKey) {
      card.extendSelectionFromCursor(current, next);
      play("select");
    } else if (card.cursor === null) next = current;
    card.setCursor(next);
    return;
  }
  if (card.cursor === null) return;
  if (event.key === " " || event.key === "Enter") {
    event.preventDefault();
    void card.flipBit(card.cursor);
  } else if (event.key === "0" || event.key === "1") {
    event.preventDefault();
    if (model.bit(card.cursor) !== Number(event.key))
      void card.flipBit(card.cursor);
  }
}

/** How many bits "up" moves the cursor (rows or wrapped lines above have higher bits when MSB comes first). */
function verticalStep(card: ValueCard): number {
  const model = card.model;
  const per = card.rows.lineBits ?? model.rowWidth;
  const higherAbove = card.line ? appSettings.get("msb_left") : model.msbFirst;
  return higherAbove ? per : -per;
}
