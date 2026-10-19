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

const VARS = [
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
  const st = document.documentElement.style;
  for (const v of VARS) st.removeProperty(v);
  if (!color || highContrast) return;
  const mix = (pct: number, other: string) => `color-mix(in srgb, ${color} ${pct}%, ${other})`;
  st.setProperty("--accent", color);
  st.setProperty("--accent-hover", mix(85, "white"));
  st.setProperty("--accent-press", mix(82, "black"));
  st.setProperty("--accent-soft", mix(14, "transparent"));
  st.setProperty("--accent-line", mix(50, "transparent"));
  st.setProperty("--bit-on", color);
  st.setProperty("--bit-on-2", mix(84, "black"));
  st.setProperty("--bit-glow", `0 0 10px ${mix(28, "transparent")}`);
  st.setProperty("--link", mix(70, "var(--muted)"));
  st.setProperty("--cmp-on", mix(45, "var(--bg)"));
}
