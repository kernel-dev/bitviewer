// Scrolling a value into view.

/** Scrolls `element` into view: smoothly when it is near, at once when it is
 *  more than a screen away (smooth-scrolling past hundreds of values makes the
 *  browser draw every one of them on the way). After a jump, `settle` builds
 *  the values around it; they can change size, so the jump is repeated until
 *  the element stays put. */
export function bringIntoView(
  element: HTMLElement,
  block: ScrollLogicalPosition = "nearest",
  settle: () => void = () => {},
) {
  const rect = element.getBoundingClientRect();
  const far =
    rect.bottom < -window.innerHeight || rect.top > 2 * window.innerHeight;

  if (!far) {
    element.scrollIntoView({ block, behavior: "smooth" });
    return;
  }

  let top = Number.NaN;

  for (let attempt = 0; attempt < 4; attempt++) {
    element.scrollIntoView({ block, behavior: "instant" });
    settle();
    const now = element.getBoundingClientRect().top;
    if (Math.abs(now - top) < 2) break;
    top = now;
  }
}
