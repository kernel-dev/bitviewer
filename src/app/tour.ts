// First-run tour: a spotlight on a few key parts of the window, with short
// explanations. Shown once (until finished or skipped) and from Help.
import { h } from "../ui/kit";

interface Step {
  target: string; // CSS selector; steps whose target isn't on screen are skipped
  title: string;
  text: string;
}

const STEPS: Step[] = [
  {
    target: ".toolbar .btn.primary",
    title: "Add values",
    text: "Add 32- or 64-bit values, or any width from 1 to 512 bits with Custom.",
  },
  {
    target: ".card .strip:not(.cmp)",
    title: "Bits",
    text: "Click a bit to flip it, drag to select, Alt+drag to paint 1s (Alt+Shift+drag for 0s). After clicking, the arrow keys move along the bits and Space flips.",
  },
  {
    target: ".card .sel-bar",
    title: "Selection",
    text: "Selected bits get their own editable value here. “Group selection” (Ctrl+G) turns them into a named register field.",
  },
  {
    target: ".card .fields",
    title: "Register fields",
    text: "Fields can be signed and have a formula with a unit, named values and a description. “Templates” adds ready-made layouts like IEEE-754 floats.",
  },
  {
    target: ".card .expr-toggle",
    title: "Expressions",
    text: "Type calculations like 0x1F << 3 | bit(31). Other values and fields can be used by name.",
  },
  {
    target: ".toolbar .btn[aria-label^='Undo']",
    title: "Undo & auto-save",
    text: "Ctrl+Z undoes any change. Your work is saved automatically and comes back after a restart.",
  },
  {
    target: ".menubar",
    title: "Find any command",
    text: "Press Ctrl+K for the command palette, F1 for help. Settings has themes, accent colours and optional sounds.",
  },
];

let running = false;

export function tourRunning(): boolean {
  return running;
}

/** Runs the tour. Resolves when it is finished or skipped. */
export function startTour(): Promise<void> {
  if (running) return Promise.resolve();
  running = true;
  const steps = STEPS.filter((s) => {
    const el = document.querySelector(s.target);
    return el && (el as HTMLElement).offsetParent !== null;
  });
  return new Promise((resolve) => {
    if (!steps.length) {
      running = false;
      resolve();
      return;
    }
    let i = 0;
    const ring = h("div", { class: "tour-ring" });
    const title = h("h3", {});
    const text = h("p", {});
    const count = h("span", { class: "muted small" });
    const back = h("button", { type: "button", class: "btn ghost sm" }, "Back");
    const next = h("button", { type: "button", class: "btn primary sm" }, "Next");
    const skip = h("button", { type: "button", class: "btn ghost sm" }, "Skip tour");
    const pop = h(
      "div",
      { class: "tour-pop", role: "dialog", "aria-live": "polite" },
      title,
      text,
      h("div", { class: "tour-actions" }, count, h("div", { class: "spacer" }), skip, back, next),
    );
    const layer = h("div", { class: "tour-layer" }, ring, pop);

    const place = () => {
      const target = document.querySelector(steps[i].target) as HTMLElement | null;
      if (!target) return;
      target.scrollIntoView({ block: "nearest" });
      const r = target.getBoundingClientRect();
      const pad = 6;
      Object.assign(ring.style, {
        left: `${r.left - pad}px`,
        top: `${r.top - pad}px`,
        width: `${r.width + pad * 2}px`,
        height: `${r.height + pad * 2}px`,
      });
      title.textContent = steps[i].title;
      text.textContent = steps[i].text;
      count.textContent = `${i + 1} of ${steps.length}`;
      back.disabled = i === 0;
      next.textContent = i === steps.length - 1 ? "Done" : "Next";
      // below the target if there's room, else above
      const pw = Math.min(360, innerWidth - 24);
      const ph = pop.offsetHeight || 150;
      const below = r.bottom + 14 + ph < innerHeight;
      pop.style.width = `${pw}px`;
      pop.style.left = `${Math.max(12, Math.min(r.left, innerWidth - pw - 12))}px`;
      pop.style.top = `${below ? r.bottom + 14 : Math.max(12, r.top - ph - 14)}px`;
      next.focus();
    };
    const finish = () => {
      running = false;
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", place);
      layer.remove();
      resolve();
    };
    const go = (d: number) => {
      i += d;
      if (i >= steps.length) finish();
      else place();
    };
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Escape") finish();
      else if (e.key === "ArrowRight" || e.key === "Enter") {
        e.preventDefault();
        go(1);
      } else if (e.key === "ArrowLeft" && i > 0) go(-1);
    };
    back.addEventListener("click", () => go(-1));
    next.addEventListener("click", () => go(1));
    skip.addEventListener("click", finish);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", place);
    document.body.append(layer);
    requestAnimationFrame(place);
  });
}
