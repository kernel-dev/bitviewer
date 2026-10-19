# Bit Viewer

A desktop app for viewing and editing values of 1–512 bits, one bit at a time. Useful for hardware registers, protocol fields and float bit patterns.

![Bit Viewer showing a 32-bit register split into named fields](docs/screenshot.png)

> [!WARNING]
> **This project is vibecoded.** The code was written by an AI (Claude, via Claude Code) from the maintainer's prompts, not by hand. The maintainer chose the features, tried the app and reported bugs. Unit and end-to-end tests check its behaviour, and the code has been reviewed line by line by a human skimmingly. Commits made with the AI carry a `Co-Authored-By: Claude` line.

## Features

- **Bits:** click to flip, drag to select, Alt+drag to paint. Full keyboard control.
- **Values:** any width from 1 to 512 bits, typed in BIN / OCT / DEC / HEX, or as an expression (`0x1F << 3 | bit(31)`).
- **Layouts:** one line across the window, or one row per byte or nibble.
- **Register fields:** name a group of bits, then give it a formula and unit, named values and read-only / reserved access.
- **Operations:** NOT, shifts, rotates, byte swap, bit reverse, AND/OR/XOR. With bits selected, they act on the selection only.
- **Readouts:** unsigned, signed, float16 / bfloat16 / float32 / float64, BCD, Gray code, parity and more.
- **Compare:** compare rows with the differing bits highlighted, plus named snapshots.
- **Templates and export:** built-in templates (IEEE-754, RGB565, IPv4…) or your own. Export fields as C macros, a C struct, Rust or Python.
- **Workspace:** undo/redo, auto-save and crash restore, search (Ctrl+F), command palette (Ctrl+K).
- **Look:** dark, light and high-contrast themes, accent colour, compact mode. Interface sounds are optional and off by default.

Press **F1** in the app for searchable help.

## Install

Build from source (below). Builds currently target Windows. Installed copies can update themselves from GitHub Releases.

## Build from source

You need Node.js 20+ and [Rust](https://rustup.rs). On Windows you also need the Microsoft C++ Build Tools. For other systems, see the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
npm install
npm run tauri dev     # run the app with hot reload
npm run tauri build   # installers in src-tauri/target/release/bundle/
```

<details>
<summary>More scripts</summary>

```bash
npm run dev          # UI only, in the browser at http://localhost:1420
npm test             # unit tests (Vitest)
npm run test:e2e     # end-to-end tests (Playwright, uses installed Microsoft Edge)
npm run check        # types, lint, unit tests, rustfmt, clippy
npm run format       # Biome + rustfmt
```

</details>

<details>
<summary>Publishing a release with auto-updates</summary>

1. In `src-tauri/tauri.conf.json`, replace `OWNER/REPO` in `plugins.updater.endpoints` with the repository.
2. Bump the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`.
3. Run `npm run release -- --notes "What changed"`. It builds a signed installer and `latest.json`, then prints the `gh release create …` command that uploads them.

Updates are signed with the private key in `~/.tauri/bitviewer.key`. Keep it private and backed up: without it, installed copies can't verify future updates.

</details>

## Shortcuts

| Action | Keys |
|---|---|
| Add 32 / 64-bit / custom width | Ctrl+1 / Ctrl+2 / Ctrl+3 |
| Undo / redo | Ctrl+Z / Ctrl+Y |
| Group selection into a field / clear selection | Ctrl+G / Esc |
| Find / command palette | Ctrl+F / Ctrl+K |
| New / open / save / save as | Ctrl+N / Ctrl+O / Ctrl+S / Ctrl+Shift+S |
| Zoom | Ctrl+wheel, Ctrl+= / Ctrl+- / Ctrl+0 |
| Toggle theme / settings / help | Ctrl+T / Ctrl+, / F1 |

## Project layout

<details>
<summary>Show</summary>

```
src/
  main.ts         entry point
  core/           logic with no UI: value model, number formats, expressions, code export
  app/            window, menus, files, undo, session, settings, search, palette
  card/           one value card: bit cells, toolbar, readouts
  ui/             shared widgets, sounds, styles
  dialogs/        settings, help, field details, export…
  (tests sit next to the code as *.test.ts)
e2e/              end-to-end tests
src-tauri/        Rust shell: file access, plugins, config
scripts/          release script
```

</details>

## Credits

Built with [Tauri 2](https://v2.tauri.app), TypeScript and Vite. Icons by [Lucide](https://lucide.dev). Fonts are Inter and JetBrains Mono, bundled so the app works offline.

## License

[MIT](LICENSE)
