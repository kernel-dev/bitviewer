// The Settings dialog. Every change applies immediately.
import { Contrast, Moon, SlidersHorizontal, Sun, Volume2 } from "lucide";
import { appSettings, ZOOM_MAX, ZOOM_MIN } from "../app/settings";
import { BASE_NAMES, BASE_ORDER } from "../core/numfmt";
import { ACCENTS } from "../ui/accent";
import { button, html, modal, segmented, toggleSwitch } from "../ui/kit";
import { play } from "../ui/sound";

function section(name: string, ...rows: HTMLElement[]): HTMLElement {
  return html(
    "section",
    { class: "set-section" },
    html("h4", {}, name),
    html("div", { class: "set-card" }, ...rows),
  );
}

function row(label: string, control: HTMLElement, hint = ""): HTMLElement {
  return html(
    "div",
    { class: "set-row" },
    html(
      "div",
      {},
      html("div", { class: "set-label" }, label),
      hint ? html("div", { class: "set-hint" }, hint) : null,
    ),
    control,
  );
}

/** Range input whose filled part tracks its value. */
function slider(
  min: number,
  max: number,
  step: number,
  value: number,
): HTMLInputElement {
  const input = html("input", {
    type: "range",
    class: "slider",
    min,
    max,
    step,
    value,
  });
  const paint = () =>
    input.style.setProperty(
      "--p",
      `${((+input.value - min) / (max - min)) * 100}%`,
    );
  input.addEventListener("input", paint);
  paint();
  return input;
}

/** Swatches for the accent presets plus a custom colour. */
function accentPicker(): HTMLElement {
  const container = html("div", {
    class: "accent-pick",
    role: "radiogroup",
    "aria-label": "Accent colour",
  });
  const current = () => appSettings.get("accent") || ACCENTS[0].color;
  const render = () => {
    const currentLower = current().toLowerCase();
    const isPreset = ACCENTS.some((accent) => accent.color === currentLower);
    container.replaceChildren(
      ...ACCENTS.map((accent) => {
        const buttonElement = html("button", {
          type: "button",
          class: `accent-swatch${accent.color === currentLower ? " on" : ""}`,
          style: `--sw:${accent.color}`,
          tip: accent.name,
          role: "radio",
          "aria-checked": accent.color === currentLower ? "true" : "false",
          "aria-label": accent.name,
        });
        buttonElement.addEventListener("click", () => {
          appSettings.set(
            "accent",
            accent.color === ACCENTS[0].color ? "" : accent.color,
          );
          render();
        });
        return buttonElement;
      }),
      (() => {
        const input = html("input", {
          type: "color",
          class: "accent-custom-input",
          value: currentLower,
          "aria-label": "Custom colour",
        });
        input.addEventListener("input", () =>
          appSettings.set("accent", input.value.toLowerCase()),
        );
        input.addEventListener("change", render);
        return html(
          "label",
          {
            class: `accent-swatch custom${isPreset ? "" : " on"}`,
            style: `--sw:${currentLower}`,
            tip: "Custom colour…",
          },
          input,
        );
      })(),
    );
  };
  render();
  return container;
}

export function openSettings(): Promise<void> {
  return modal<void>({
    title: "Settings",
    icon: SlidersHorizontal,
    wide: true,
    cancelValue: undefined,
    build: (body, close) => {
      const theme = segmented(
        [
          { value: "dark" as const, label: "Dark", icon: Moon },
          { value: "light" as const, label: "Light", icon: Sun },
          {
            value: "contrast" as const,
            label: "High contrast",
            icon: Contrast,
          },
        ],
        {
          value: appSettings.get("theme"),
          onPick: (value) => appSettings.set("theme", value),
        },
      );

      const zoomVal = html(
        "span",
        { class: "mono zoom-val" },
        `${Math.round(appSettings.get("zoom") * 100)}%`,
      );
      const zoom = slider(
        ZOOM_MIN * 100,
        ZOOM_MAX * 100,
        10,
        Math.round(appSettings.get("zoom") * 100),
      );
      zoom.addEventListener("input", () => {
        zoomVal.textContent = `${zoom.value}%`;
      });
      zoom.addEventListener("change", () =>
        appSettings.set("zoom", +zoom.value / 100),
      );

      const order = segmented(
        [
          { value: true, label: "MSB left  7…0" },
          { value: false, label: "LSB left  0…7" },
        ],
        {
          value: appSettings.get("msb_left"),
          onPick: (value) => appSettings.set("msb_left", value),
        },
      );
      const view = segmented(
        [
          { value: "line" as const, label: "Line" },
          { value: "byte" as const, label: "Bytes" },
          { value: "nibble" as const, label: "Nibbles" },
        ],
        {
          value: appSettings.get("default_view"),
          onPick: (value) => appSettings.set("default_view", value),
        },
      );
      const base = segmented(
        BASE_ORDER.map((base) => ({ value: base, label: BASE_NAMES[base] })),
        {
          value: appSettings.get("default_base"),
          onPick: (base) => appSettings.set("default_base", base),
        },
      );

      const volVal = html(
        "span",
        { class: "mono zoom-val" },
        `${Math.round(appSettings.get("sound_volume") * 100)}%`,
      );
      const volume = slider(
        0,
        100,
        5,
        Math.round(appSettings.get("sound_volume") * 100),
      );
      const syncVolume = () => {
        volume.disabled = !appSettings.get("sounds");
      };
      syncVolume();
      volume.addEventListener("input", () => {
        volVal.textContent = `${volume.value}%`;
        appSettings.set("sound_volume", +volume.value / 100);
      });
      volume.addEventListener("change", () => play("bitOn"));
      const sounds = toggleSwitch(appSettings.get("sounds"), (value) => {
        appSettings.set("sounds", value);
        syncVolume();
        if (value) play("bitOn");
      });

      body.append(
        section(
          "Appearance",
          row("Theme", theme.element),
          row(
            "Accent colour",
            accentPicker(),
            "Red by default; used for bits that are 1, buttons and highlights",
          ),
          row(
            "Compact mode",
            toggleSwitch(appSettings.get("compact"), (value) =>
              appSettings.set("compact", value),
            ),
            "Tighter spacing, so more values fit on screen",
          ),
          row(
            "Zoom",
            html("div", { class: "zoom-ctl" }, zoom, zoomVal),
            "Ctrl + mouse wheel anywhere · Ctrl+0 resets",
          ),
        ),
        section(
          "Bits",
          row("Bit order in a row", order.element),
          row(
            "Layout for new values",
            view.element,
            "Line puts every bit on one line across the window",
          ),
          row("Row base for new values", base.element),
        ),
        section(
          "Sounds",
          row(
            "Interface sounds",
            sounds,
            "Short sounds for flipping bits, selecting, fields, operations and errors",
          ),
          row(
            "Volume",
            html(
              "div",
              { class: "zoom-ctl" },
              volume,
              volVal,
              button({
                icon: Volume2,
                className: "ghost sm",
                tip: "Play a test sound",
                onClick: () => play("group", true),
              }),
            ),
          ),
        ),
        section(
          "Updates",
          row(
            "Check for updates at start-up",
            toggleSwitch(appSettings.get("check_updates"), (value) =>
              appSettings.set("check_updates", value),
            ),
            "Help › Check for updates… works either way",
          ),
        ),
        section(
          "Readouts",
          row(
            "Per-row readouts",
            toggleSwitch(appSettings.get("show_readouts"), (value) =>
              appSettings.set("show_readouts", value),
            ),
            "hex · dec · oct next to each byte / nibble row",
          ),
          row(
            "Interpretations",
            toggleSwitch(appSettings.get("show_interp"), (value) =>
              appSettings.set("show_interp", value),
            ),
            "unsigned, signed, set bits and IEEE-754 float",
          ),
        ),
      );
      return [
        button({ label: "Done", className: "primary", onClick: () => close() }),
      ];
    },
  });
}
