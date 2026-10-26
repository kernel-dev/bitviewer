// Tooltips: any element can have a text (or a function giving one) shown
// after a short hover. Bit cells show theirs next to the pointer.

const tooltips = new WeakMap<Element, string | (() => string)>();

export function setTip(
  element: Element,
  tip: string | (() => string) | undefined,
) {
  if (tip) tooltips.set(element, tip);
  else tooltips.delete(element);
}

let tipEl: HTMLElement | null = null;
let tipTimer = 0;
let tipTarget: Element | null = null;

function findTip(target: EventTarget | null): Element | null {
  let element = target instanceof Element ? target : null;
  while (element && !tooltips.has(element)) element = element.parentElement;
  return element;
}

export function showTip(target: Element, text: string, x?: number, y?: number) {
  if (!text) return hideTip();

  if (!tipEl) {
    tipEl = document.body.appendChild(document.createElement("div"));
    tipEl.className = "tooltip";
    tipEl.setAttribute("role", "tooltip");
  }

  tipEl.textContent = text;
  tipEl.classList.add("show");

  const rect = target.getBoundingClientRect();
  const tipWidth = tipEl.offsetWidth;
  const tipHeight = tipEl.offsetHeight;

  let left =
    x !== undefined ? x + 12 : rect.left + rect.width / 2 - tipWidth / 2;
  let top = y !== undefined ? y + 18 : rect.bottom + 8;
  if (top + tipHeight > innerHeight - 6)
    top = (y !== undefined ? y - 10 : rect.top - 8) - tipHeight;

  left = Math.max(6, Math.min(left, innerWidth - tipWidth - 6));

  tipEl.style.left = `${left}px`;
  tipEl.style.top = `${Math.max(6, top)}px`;
}

export function hideTip() {
  clearTimeout(tipTimer);
  tipTarget = null;
  tipEl?.classList.remove("show");
}

export function installTooltips() {
  let lastX = 0;
  let lastY = 0;

  document.addEventListener("pointerover", (event) => {
    const target = findTip(event.target);
    if (target === tipTarget) return;

    hideTip();

    if (!target || event.buttons) return;

    tipTarget = target;

    tipTimer = window.setTimeout(() => {
      const tip = tooltips.get(target);
      const text = typeof tip === "function" ? tip() : tip;
      // bit cells follow the pointer, everything else anchors below the element
      if (text)
        target.classList.contains("bit")
          ? showTip(target, text, lastX, lastY)
          : showTip(target, text);
    }, 450);
  });

  document.addEventListener("pointermove", (event) => {
    lastX = event.clientX;
    lastY = event.clientY;
  });

  document.addEventListener("pointerdown", hideTip, true);
  document.addEventListener("wheel", hideTip, { passive: true });
  document.addEventListener("keydown", hideTip, true);
}
