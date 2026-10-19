# Bit Viewer

A desktop tool for inspecting and editing values of 1 to 512 bits, bit by bit — handy for embedded registers, protocol fields and float bit patterns.

Built with [Tauri 2](https://v2.tauri.app) (Rust shell + system webview) and a TypeScript / Vite frontend. Icons are [Lucide](https://lucide.dev); fonts are Inter and JetBrains Mono (bundled, works offline).

## Requirements

- Node.js 20+
- Rust (stable) — install with [rustup](https://rustup.rs)
- Windows: Microsoft C++ Build Tools and WebView2 (preinstalled on Windows 10/11).
  macOS / Linux: see the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

## Develop

```bash
npm install
npm run tauri dev     # native window with hot reload
npm run dev           # UI only, in the browser at http://localhost:1420
npm test              # unit tests for the value model and number parsing
```

## Build

```bash
npm run tauri build                     # release exe + installers (NSIS .exe, .msi)
npm run tauri build -- --no-bundle      # just the exe
```

Output lands in `src-tauri/target/release/` (`BitViewer.exe`) and `src-tauri/target/release/bundle/`. Tauri doesn't cross-compile, so build on each OS you want to ship. To regenerate the app icons after editing `app-icon.svg`: `npx tauri icon app-icon.svg`.

## Using it

**Values.** Add 32-bit (Ctrl+1) or 64-bit (Ctrl+2) values, or any width from 1 to 512 bits with "Custom" (Ctrl+3). Change an existing value's width from its "⋯" menu or by clicking its width badge. Each card has a name, a whole-value field with its own base, and a layout you choose per value:
- **Line** puts every bit on one line stretched across the window. When it doesn't fit, it wraps onto lines of 256, 128, 64 … bits, aligned so columns line up.
- **Bytes** / **Nibbles** show one row per byte or nibble, each with its own base, value field and readout. The bit cells stretch to use the space the controls leave free. If the width isn't a multiple of 8 (or 4), the top row is shorter. "MSB row first" / "LSB row first" toggles row order; LSB-first in byte view is the little-endian memory order.

New values use the layout set in Settings (Line by default). Settings also lets you put the LSB on the left inside each row.

**Editing.**
- Click a bit to flip it.
- Type into any field in the base selected next to it (BIN / OCT / DEC / HEX). The toolbar's "All rows" buttons switch every row at once.
- Prefixes `0x`, `0b`, `0o` override the base. In HEX mode `0b…` is read as hex digits, since `0B` is valid hex.
- Spaces and `_` are ignored.
- The whole-value field accepts negative decimals and stores them as two's complement.
- Invalid input turns the field red, with the reason in a tooltip. Esc reverts.

**Readouts.** Byte/nibble rows show hex · dec · oct, plus the ASCII character for printable bytes. Under each card are chips with unsigned, signed and set-bit count, plus the IEEE-754 float for 32- and 64-bit values. Both can be hidden in Settings.

**All bases.** "Bases" on a value's toolbar (or its "⋯" menu) opens a panel showing the value in HEX, DEC, OCT and BIN at once. Every line is editable and has its own copy button. It's off by default and saved per value.

**Operations.** NOT, CLR, SET, ≪ and ≫ apply to the whole value. A row's "⋯" button, or right-clicking its bits, applies them to that row and offers copy-as-base. "Copy" copies the whole value.

**Register fields.**
- Drag across bits to select them (also across rows); Shift+click extends the selection. Click anywhere else, or press Esc, to clear it.
- In byte/nibble view, click a row label, then Shift+click another, to select consecutive whole rows.
- Press "Group selection" (Ctrl+G) to make the selection a named field. Fields may span rows but cannot overlap.
- Each field has a colour, a name, its own base and an editable value. Right-click one of its bits to rename it, recolour it or remove it.
- Named fields stay until you remove them. Clicking elsewhere only clears an unnamed selection, and shrinking a value below a field is refused until you remove that field.

**Compare rows.** "Compare" opens a linked, toned-down row with its own independent value. It inherits the parent row's fields; bits that differ are outlined in cyan with a dot, and the row shows "Δ n bits · XOR". Compare values survive switching layouts, and closing a compare row keeps its value: reopening it brings your edits back (also after saving and reopening the file).

**Zoom.** Ctrl + mouse wheel, Ctrl+= / Ctrl+-, Ctrl+0 to reset, the status-bar buttons, or Settings (50–300 %).

**Sounds.** Optional interface sounds for flipping bits, selecting, creating and removing fields, operations, copying and invalid input. They're off by default; turn them on in Settings (with a volume slider and a test button) or from the View menu. The sounds are generated in code, so there are no audio files.

**Theme.** Dark (default) or light, both with the red/black accent (Ctrl+T). Settings and window size persist between runs.

**Files.** Workspaces save as readable JSON (`*.bitview.json`) with values, names, layouts, bases, compare rows and fields. Files from the earlier Python version open unchanged. You can also pass a workspace path on the command line: `BitViewer.exe my.bitview.json`.

## Shortcuts

| Action | Keys |
|---|---|
| Add 32 / 64-bit value | Ctrl+1 / Ctrl+2 |
| Add value with custom width | Ctrl+3 |
| Group selection | Ctrl+G |
| Clear selection | Esc |
| Zoom in / out / reset | Ctrl+wheel, Ctrl+= / Ctrl+- / Ctrl+0 |
| Toggle theme | Ctrl+T |
| Settings | Ctrl+, |
| New / Open / Save / Save as | Ctrl+N / Ctrl+O / Ctrl+S / Ctrl+Shift+S |
| Controls help | F1 |

## Project layout

```
src/
  model.ts        value model (no DOM) — bits, rows, compares, fields, JSON
  numfmt.ts       BigInt parsing/formatting in BIN/OCT/DEC/HEX, signed and float views
  core.test.ts    unit tests (Vitest)
  bitstrip.ts     bit cells: flip, drag-select, wrapping line layout, field bars
  card.ts         one value card (header, rows, compare rows, fields, stats)
  app.ts          window chrome, menus, toolbar, files, shortcuts, dialogs
  ui.ts           UI kit: segmented control, switch, menus, dialogs, tooltips, number input
  settings.ts     persisted settings
  platform.ts     Tauri bridge (files, dialogs, zoom, window) with browser fallbacks
  styles.css      red/black theme (dark + light)
src-tauri/
  src/lib.rs      file read/write commands, command-line file, plugins
  tauri.conf.json window, bundle and security config
  capabilities/   permissions granted to the window
app-icon.svg      source for the generated app icons
```
