// The Settings dialog. Every change applies immediately.
import { Contrast, Moon, SlidersHorizontal, Sun, Volume2 } from "lucide";
import { ACCENTS } from "../accent";
import { BASE_NAMES, BASE_ORDER } from "../numfmt";
import { S, ZOOM_MAX, ZOOM_MIN } from "../settings";
import { play } from "../sound";
import { button, h, modal, segmented, toggleSwitch } from "../ui";

function section(name: string, ...rows: HTMLElement[]): HTMLElement {
  return h("section", { class: "set-section" }, h("h4", {}, name), h("div", { class: "set-card" }, ...rows));
}

function row(label: string, control: HTMLElement, hint = ""): HTMLElement {
  return h(
    "div",
    { class: "set-row" },
    h("div", {}, h("div", { class: "set-label" }, label), hint ? h("div", { class: "set-hint" }, hint) : null),
    control,
  );
}

/** Range input whose filled part tracks its value. */
function slider(min: number, max: number, step: number, value: number): HTMLInputElement {
  const s = h("input", { type: "range", class: "slider", min, max, step, value });
  const paint = () => s.style.setProperty("--p", `${((+s.value - min) / (max - min)) * 100}%`);
  s.addEventListener("input", paint);
  paint();
  return s;
}

/** Swatches for the accent presets plus a custom colour. */
function accentPicker(): HTMLElement {
  const wrap = h("div", { class: "accent-pick", role: "radiogroup", "aria-label": "Accent colour" });
  const current = () => S.get("accent") || ACCENTS[0].color;
  const render = () => {
    const cur = current().toLowerCase();
    const isPreset = ACCENTS.some((a) => a.color === cur);
    wrap.replaceChildren(
      ...ACCENTS.map((a) => {
        const b = h("button", {
          type: "button",
          class: `accent-swatch${a.color === cur ? " on" : ""}`,
          style: `--sw:${a.color}`,
          tip: a.name,
          role: "radio",
          "aria-checked": a.color === cur ? "true" : "false",
          "aria-label": a.name,
        });
        b.addEventListener("click", () => {
          S.set("accent", a.color === ACCENTS[0].color ? "" : a.color);
          render();
        });
        return b;
      }),
      (() => {
        const input = h("input", {
          type: "color",
          class: "accent-custom-input",
          value: cur,
          "aria-label": "Custom colour",
        });
        input.addEventListener("input", () => S.set("accent", input.value.toLowerCase()));
        input.addEventListener("change", render);
        return h(
          "label",
          { class: `accent-swatch custom${isPreset ? "" : " on"}`, style: `--sw:${cur}`, tip: "Custom colour…" },
          input,
        );
      })(),
    );
  };
  render();
  return wrap;
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
          { value: "contrast" as const, label: "High contrast", icon: Contrast },
        ],
        { value: S.get("theme"), onPick: (v) => S.set("theme", v) },
      );

      const zoomVal = h("span", { class: "mono zoom-val" }, `${Math.round(S.get("zoom") * 100)}%`);
      const zoom = slider(ZOOM_MIN * 100, ZOOM_MAX * 100, 10, Math.round(S.get("zoom") * 100));
      zoom.addEventListener("input", () => {
        zoomVal.textContent = `${zoom.value}%`;
      });
      zoom.addEventListener("change", () => S.set("zoom", +zoom.value / 100));

      const order = segmented(
        [
          { value: true, label: "MSB left  7…0" },
          { value: false, label: "LSB left  0…7" },
        ],
        { value: S.get("msb_left"), onPick: (v) => S.set("msb_left", v) },
      );
      const view = segmented(
        [
          { value: "line" as const, label: "Line" },
          { value: "byte" as const, label: "Bytes" },
          { value: "nibble" as const, label: "Nibbles" },
        ],
        { value: S.get("default_view"), onPick: (v) => S.set("default_view", v) },
      );
      const base = segmented(
        BASE_ORDER.map((b) => ({ value: b, label: BASE_NAMES[b] })),
        { value: S.get("default_base"), onPick: (v) => S.set("default_base", v) },
      );

      const volVal = h("span", { class: "mono zoom-val" }, `${Math.round(S.get("sound_volume") * 100)}%`);
      const volume = slider(0, 100, 5, Math.round(S.get("sound_volume") * 100));
      const syncVolume = () => {
        volume.disabled = !S.get("sounds");
      };
      syncVolume();
      volume.addEventListener("input", () => {
        volVal.textContent = `${volume.value}%`;
        S.set("sound_volume", +volume.value / 100);
      });
      volume.addEventListener("change", () => play("bitOn"));
      const sounds = toggleSwitch(S.get("sounds"), (v) => {
        S.set("sounds", v);
        syncVolume();
        if (v) play("bitOn");
      });

      body.append(
        section(
          "Appearance",
          row("Theme", theme.el),
          row("Accent colour", accentPicker(), "Red by default; used for bits that are 1, buttons and highlights"),
          row(
            "Compact mode",
            toggleSwitch(S.get("compact"), (v) => S.set("compact", v)),
            "Tighter spacing, so more values fit on screen",
          ),
          row("Zoom", h("div", { class: "zoom-ctl" }, zoom, zoomVal), "Ctrl + mouse wheel anywhere · Ctrl+0 resets"),
        ),
        section(
          "Bits",
          row("Bit order in a row", order.el),
          row("Layout for new values", view.el, "Line puts every bit on one line across the window"),
          row("Row base for new values", base.el),
        ),
        section(
          "Sounds",
          row("Interface sounds", sounds, "Short sounds for flipping bits, selecting, fields, operations and errors"),
          row(
            "Volume",
            h(
              "div",
              { class: "zoom-ctl" },
              volume,
              volVal,
              button({ icon: Volume2, cls: "ghost sm", tip: "Play a test sound", onClick: () => play("group", true) }),
            ),
          ),
        ),
        section(
          "Readouts",
          row(
            "Per-row readouts",
            toggleSwitch(S.get("show_readouts"), (v) => S.set("show_readouts", v)),
            "hex · dec · oct next to each byte / nibble row",
          ),
          row(
            "Interpretations",
            toggleSwitch(S.get("show_interp"), (v) => S.set("show_interp", v)),
            "unsigned, signed, set bits and IEEE-754 float",
          ),
        ),
      );
      return [button({ label: "Done", cls: "primary", onClick: () => close() })];
    },
  });
}
