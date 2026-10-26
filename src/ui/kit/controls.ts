// Segmented control (a row of pill buttons) and on/off switch.

import type { IconNode } from "lucide";
import { play } from "../sound";
import { html, icon } from "./dom";

export interface Segmented<T> {
  element: HTMLElement;
  value: T | undefined;
  set(value: T): void;
}

/** Pill-shaped segmented control. `checkable: false` makes it a row of
 *  action buttons that fire `onPick` without keeping a selection. */
export function segmented<T>(
  options: { value: T; label?: string; icon?: IconNode; tip?: string }[],
  config: {
    value?: T;
    checkable?: boolean;
    onPick: (value: T) => void;
    className?: string;
  },
): Segmented<T> {
  const checkable = config.checkable ?? true;
  const element = html("div", {
    class: `seg ${config.className ?? ""}`,
    role: checkable ? "radiogroup" : "group",
  });
  const buttons = new Map<T, HTMLButtonElement>();

  const control: Segmented<T> = {
    element,
    value: config.value,
    set(value: T) {
      control.value = value;
      if (checkable) {
        for (const [key, buttonElement] of buttons) {
          buttonElement.classList.toggle("on", key === value);
          buttonElement.setAttribute(
            "aria-checked",
            key === value ? "true" : "false",
          );
        }
      }
    },
  };

  for (const option of options) {
    const buttonElement = html("button", {
      type: "button",
      class: "seg-btn",
      tip: option.tip,
      role: checkable ? "radio" : undefined,
      "aria-label": option.label ? undefined : option.tip,
    });

    if (option.icon) buttonElement.append(icon(option.icon, 14));
    if (option.label) buttonElement.append(html("span", {}, option.label));

    buttonElement.addEventListener("click", () => {
      if (checkable) {
        const changed = control.value !== option.value;
        control.set(option.value);

        if (changed) {
          play("toggle");
          config.onPick(option.value);
        }
      } else {
        config.onPick(option.value);
      }
    });

    buttons.set(option.value, buttonElement);
    element.append(buttonElement);
  }

  if (config.value !== undefined) control.set(config.value);

  return control;
}

export function toggleSwitch(
  checked: boolean,
  onChange: (value: boolean) => void,
): HTMLElement {
  const input = html("input", {
    type: "checkbox",
    checked,
    class: "switch-input",
  });

  input.addEventListener("change", () => {
    onChange(input.checked);
    play("toggle");
  });

  return html(
    "label",
    { class: "switch" },
    input,
    html(
      "span",
      { class: "switch-track" },
      html("span", { class: "switch-knob" }),
    ),
  );
}
