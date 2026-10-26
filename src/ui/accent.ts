// Accent colour: red by default; any colour can be chosen in Settings. Every
// accent-derived colour is mixed from the one base colour.

export const ACCENTS: { name: string; color: string }[] = [
  { name: "Red", color: "#e5383b" },
  { name: "Orange", color: "#f76707" },
  { name: "Amber", color: "#f59f00" },
  { name: "Green", color: "#2fb344" },
  { name: "Teal", color: "#0ca678" },
  { name: "Blue", color: "#3b82f6" },
  { name: "Violet", color: "#8b5cf6" },
  { name: "Pink", color: "#e64980" },
];

const ACCENT_VARIABLES = [
  "--accent",
  "--accent-hover",
  "--accent-press",
  "--accent-soft",
  "--accent-line",
  "--bit-on",
  "--bit-on-2",
  "--bit-glow",
  "--link",
  "--cmp-on",
];

/** Applies `color` (or the theme default for "") as the accent. High contrast keeps its own colours. */
export function applyAccent(color: string, highContrast: boolean) {
  const style = document.documentElement.style;
  for (const value of ACCENT_VARIABLES) style.removeProperty(value);
  if (!color || highContrast) return;
  const mixWith = (percent: number, other: string) =>
    `color-mix(in srgb, ${color} ${percent}%, ${other})`;
  style.setProperty("--accent", color);
  style.setProperty("--accent-hover", mixWith(85, "white"));
  style.setProperty("--accent-press", mixWith(82, "black"));
  style.setProperty("--accent-soft", mixWith(14, "transparent"));
  style.setProperty("--accent-line", mixWith(50, "transparent"));
  style.setProperty("--bit-on", color);
  style.setProperty("--bit-on-2", mixWith(84, "black"));
  style.setProperty("--bit-glow", `0 0 10px ${mixWith(28, "transparent")}`);
  style.setProperty("--link", mixWith(70, "var(--muted)"));
  style.setProperty("--cmp-on", mixWith(45, "var(--bg)"));
}
