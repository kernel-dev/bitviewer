# Bit Viewer

A desktop tool for inspecting and editing values of 1 to 512 bits, bit by bit — for embedded registers, protocol fields and float bit patterns.

Built with [Tauri 2](https://v2.tauri.app) (Rust shell + system webview) and TypeScript / Vite. Icons are [Lucide](https://lucide.dev); fonts are Inter and JetBrains Mono (bundled, works offline).

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
npm test              # unit tests (Vitest)
npm run test:e2e      # end-to-end tests: drives the real UI in the installed Microsoft Edge
npm run check         # types, lint, unit tests, rustfmt and clippy
npm run format        # Biome + rustfmt
```

Workspace files are ignored by the dev watchers, so saving one inside the project doesn't restart `tauri dev`.

## Build and release

```bash
npm run tauri build                           # exe + installers (NSIS .exe, .msi) in src-tauri/target/release/bundle/
npm run release -- --notes "What changed"     # signed build + latest.json for auto-updates
```

**Auto-updates.** Installed copies check `latest.json` on GitHub Releases at start-up (can be turned off in Settings) and from Help › Check for updates. To publish:

1. In `src-tauri/tauri.conf.json`, replace `OWNER/REPO` in `plugins.updater.endpoints` with your repository.
2. Bump the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`.
3. Run `npm run release`; it prints the `gh release create …` command that uploads the installer and `latest.json`.

Updates are signed with the private key at `~/.tauri/bitviewer.key` (generated with `npx tauri signer generate`). Keep it private and backed up: without it, installed copies can't verify future updates. The public key is in `tauri.conf.json`.

Tauri doesn't cross-compile; build on each OS you want to ship. To regenerate the app icons after editing `app-icon.svg`: `npx tauri icon app-icon.svg`.

## Using it

Press **F1** for searchable help, **Ctrl+K** for the command palette. A short tour runs on first start (Help › Take the tour replays it).

**Values.** Add 32-bit (Ctrl+1), 64-bit (Ctrl+2) or any width from 1 to 512 bits (Ctrl+3), from a template, or from an expression over other values. Change a width from the value's ⋯ menu or its width badge; shrinking below a named field is refused.

**Layouts.** **Line** puts every bit on one line across the window, wrapping onto aligned lines of 256, 128, 64 … bits when it doesn't fit. **Bytes** / **Nibbles** show one row per byte or nibble with its own base, value and readout; the top row is shorter when the width isn't a multiple of 8 (or 4). Bit cells stretch to the available width.

**Editing bits.**
- Click a bit to flip it; drag (across rows too) to select; Shift+click extends; click a row label, Shift+click another for whole rows. Clicking elsewhere clears an unnamed selection.
- Keyboard: click or Tab to the bits, then arrows move, Space flips, 0/1 set, Shift+arrows select, Home/End jump.
- Paint: Alt+drag sets bits to 1, Alt+Shift+drag to 0 (one undo step).
- The selected bits get their own editable value in the toolbar.

**Typing values.** Any field takes its base (BIN / OCT / DEC / HEX); `0x` / `0b` / `0o` override it (in HEX, `0b…` is hex digits); spaces and `_` are ignored; the whole-value field accepts negative decimals (two's complement). Invalid input turns red with the reason; Esc reverts.

**Expressions.** The ƒx button opens an expression bar (e.g. `0x1F << 3 | bit(31)`). Operators `+ - * / % ** << >> & | ^ ~ !`; functions `min max abs bit mask popcount`; names `x` (this value), this value's fields and other values (`{Name with spaces}`). Results are exact BigInt arithmetic.

**Operations.** NOT, CLR, SET, ≪, ≫ and (via ⌄) rotate, arithmetic shift, shift/rotate by N, swap bytes, reverse bits, negate, increment, decrement, AND/OR/XOR with a mask. With bits selected, operations act on the selection only.

**Register fields.** Select bits and press Group selection (Ctrl+G). Fields may span rows, can't overlap, and are only removed by you. Field details add a description, signed reading, a formula with a unit (`x * 0.5 - 40` °C — linear formulas can be typed back in), named values (0 = Off, 1 = Auto…) and access: read-only / reserved fields are hatched and ask before their bits change.

**Templates and code export.** Built-in layouts (IEEE-754 float32/64/16, bfloat16, RGB565, ARGB8888, IPv4, UTF-8 lead byte) or your own, saved from a value. Export code produces C macros, a C bitfield struct, a Rust module or Python helpers.

**Compare rows and snapshots.** Compare opens a linked row with its own value; differing bits are outlined and the row shows Δ and XOR. A closed compare row keeps its value. ⋯ › Compare with fills compare rows from another value. Snapshots save named copies of a value to restore or compare.

**Readouts.** Unsigned, signed, set bits and IEEE-754 floats (float16 and bfloat16 for 16-bit values); click a float to type a number. The + after the chips adds text, BCD, Gray code, one's complement, zero counts, parity and the highest set bit. ⋯ › Paste bytes / Copy as bytes handle hex, C and Python notation in either byte order. "Bases" shows the value in every base at once.

**Workspace.** Undo/redo everything (Ctrl+Z / Ctrl+Y). Work is auto-saved and restored after a restart or crash. Drag values by their handle to reorder, collapse them to one line, search with Ctrl+F. Workspaces save as `.bitview` (JSON); double-clicking one opens it (in the running window if Bit Viewer is open); dropping one on the window or File › Open recent works too. Older `.bitview.json` files open unchanged.

**Customising.** Dark, light or high-contrast theme (Ctrl+T toggles dark/light), accent colour, compact mode, zoom (Ctrl+wheel, Ctrl+= / Ctrl+- / Ctrl+0), bit order, defaults for new values, optional interface sounds (off by default). Settings live in `settings.json` in the app's config folder.

## Shortcuts

| Action | Keys |
|---|---|
| Add 32 / 64-bit / custom width | Ctrl+1 / Ctrl+2 / Ctrl+3 |
| Undo / redo | Ctrl+Z / Ctrl+Y or Ctrl+Shift+Z |
| Group selection / clear selection | Ctrl+G / Esc |
| Find / command palette | Ctrl+F / Ctrl+K or Ctrl+Shift+P |
| Zoom in / out / reset | Ctrl+wheel, Ctrl+= / Ctrl+- / Ctrl+0 |
| Toggle theme / settings | Ctrl+T / Ctrl+, |
| New / Open / Save / Save as | Ctrl+N / Ctrl+O / Ctrl+S / Ctrl+Shift+S |
| Help | F1 |

## Project layout

```
src/
  app.ts          window chrome, menus, files, undo, session, drag-reorder, commands
  commands.ts     command registry (menus, shortcuts, palette, help are built from it)
  card.ts         one value card: header, toolbar, rows, fields, keyboard, paint
  bitstrip.ts     bit cells: flip, select, wrapping layout, field bars, a11y
  model.ts        value model (no DOM): bits, rows, compares, fields, snapshots, JSON
  numfmt.ts       BigInt parsing/formatting in BIN/OCT/DEC/HEX
  formats.ts      floats (16/bf16/32/64), bytes, extra readouts
  expr.ts         expression parser and evaluators (integer and real)
  fieldfmt.ts     field formulas, signed values, typed-in values
  codegen.ts      C / C struct / Rust / Python export
  templates.ts    built-in field templates
  history.ts      undo/redo over workspace snapshots
  session.ts      auto-save / restore
  settings.ts     settings.json store
  search.ts, palette.ts, tour.ts, stats.ts, selbar.ts, exprbar.ts, ops-ui.ts, sound.ts, accent.ts
  dialogs/        settings, help, width, field details, templates, export, bytes, new value
  ui.ts           UI kit: segmented control, switch, menus, dialogs, tooltips, number input
  platform.ts     Tauri bridge with browser fallbacks
  styles.css      themes and styles
  *.test.ts       unit tests
e2e/              end-to-end tests (Playwright)
scripts/release.mjs  signed release + latest.json
src-tauri/        Rust shell: file commands, plugins, config, icons
```
