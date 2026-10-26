// The app mark: a 4×4 grid of bits, same as the app icon.
const ACTIVE_CELLS = [1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1, 0, 1];

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

function rect(attributes: Record<string, string | number>): SVGRectElement {
  const rect = document.createElementNS(SVG_NAMESPACE, "rect");

  for (const [attributeName, value] of Object.entries(attributes))
    rect.setAttribute(attributeName, String(value));

  return rect;
}

export function logoSvg(size: number): SVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");

  svg.setAttribute("viewBox", "0 0 64 64");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");

  svg.classList.add("logo");

  svg.append(
    rect({ x: 1, y: 1, width: 62, height: 62, rx: 14, class: "logo-bg" }),
  );

  ACTIVE_CELLS.forEach((value, index) => {
    svg.append(
      rect({
        x: 9 + (index % 4) * 12,
        y: 9 + Math.floor(index / 4) * 12,
        width: 10,
        height: 10,
        rx: 2.5,
        class: value ? "logo-on" : "logo-off",
      }),
    );
  });

  return svg;
}
