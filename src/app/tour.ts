// First-run tour: a spotlight on a few key parts of the window, with short
// explanations. Shown once (until finished or skipped) and from Help.
import { html } from "../ui/kit";

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
  const steps = STEPS.filter((step) => {
    const element = document.querySelector(step.target);
    return element && (element as HTMLElement).offsetParent !== null;
  });
  return new Promise((resolve) => {
    if (!steps.length) {
      running = false;
      resolve();
      return;
    }
    let stepIndex = 0;
    const ringElement = html("div", { class: "tour-ring" });
    const title = html("h3", {});
    const text = html("p", {});
    const count = html("span", { class: "muted small" });
    const back = html(
      "button",
      { type: "button", class: "btn ghost sm" },
      "Back",
    );
    const next = html(
      "button",
      { type: "button", class: "btn primary sm" },
      "Next",
    );
    const skip = html(
      "button",
      { type: "button", class: "btn ghost sm" },
      "Skip tour",
    );
    const popover = html(
      "div",
      { class: "tour-pop", role: "dialog", "aria-live": "polite" },
      title,
      text,
      html(
        "div",
        { class: "tour-actions" },
        count,
        html("div", { class: "spacer" }),
        skip,
        back,
        next,
      ),
    );
    const layer = html("div", { class: "tour-layer" }, ringElement, popover);

    const place = () => {
      const target = document.querySelector(
        steps[stepIndex].target,
      ) as HTMLElement | null;
      if (!target) return;
      target.scrollIntoView({ block: "nearest" });
      const rect = target.getBoundingClientRect();
      const padding = 6;
      Object.assign(ringElement.style, {
        left: `${rect.left - padding}px`,
        top: `${rect.top - padding}px`,
        width: `${rect.width + padding * 2}px`,
        height: `${rect.height + padding * 2}px`,
      });
      title.textContent = steps[stepIndex].title;
      text.textContent = steps[stepIndex].text;
      count.textContent = `${stepIndex + 1} of ${steps.length}`;
      back.disabled = stepIndex === 0;
      next.textContent = stepIndex === steps.length - 1 ? "Done" : "Next";
      // below the target if there's room, else above
      const popWidth = Math.min(360, innerWidth - 24);
      const popHeight = popover.offsetHeight || 150;
      const below = rect.bottom + 14 + popHeight < innerHeight;
      popover.style.width = `${popWidth}px`;
      popover.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - popWidth - 12))}px`;
      popover.style.top = `${below ? rect.bottom + 14 : Math.max(12, rect.top - popHeight - 14)}px`;
      next.focus();
    };
    const finish = () => {
      running = false;
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", place);
      layer.remove();
      resolve();
    };
    const goBy = (delta: number) => {
      stepIndex += delta;
      if (stepIndex >= steps.length) finish();
      else place();
    };
    const onKey = (event: KeyboardEvent) => {
      event.stopPropagation();
      if (event.key === "Escape") finish();
      else if (event.key === "ArrowRight" || event.key === "Enter") {
        event.preventDefault();
        goBy(1);
      } else if (event.key === "ArrowLeft" && stepIndex > 0) goBy(-1);
    };
    back.addEventListener("click", () => goBy(-1));
    next.addEventListener("click", () => goBy(1));
    skip.addEventListener("click", finish);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", place);
    document.body.append(layer);
    requestAnimationFrame(place);
  });
}
