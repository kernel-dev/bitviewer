# Bit Viewer

A desktop app for viewing and editing values of 1–512 bits, one bit at a time. Useful for hardware registers, protocol fields and float bit patterns.

![Bit Viewer showing an RNG control register as a datasheet table, with its reserved bits locked](docs/screenshot.png)

> [!WARNING]
> **This project is vibecoded.** The code was written by an AI (Claude, via Claude Code) from the maintainer's prompts, not by hand. The maintainer chose the features, tried the app and reported bugs. Tests check its behaviour, and the code has been reviewed line by line by a human skimmingly. Commits made with the AI carry a `Co-Authored-By: Claude` line.

## Features

- **Bits:** click to flip, drag to select, Alt+drag to paint. Full keyboard control.
- **Values:** any width from 1 to 512 bits, typed in BIN / OCT / DEC / HEX, or as an expression (`0x1F << 3 | bit(31)`).
- **Layouts:** datasheet tables 16 bits wide, or one row per byte or nibble.
- **Register fields:** name a group of bits, then give it a formula and unit, named values and read-only / reserved access. Protected bits, and bits that belong to no field, are locked and ask before they change.
- **Operations:** NOT, shifts, rotates, byte swap, bit reverse, AND/OR/XOR. With bits selected, they act on the selection only.
- **Readouts:** unsigned, signed, float16 / bfloat16 / float32 / float64, BCD, Gray code, parity and more.
- **Compare:** compare rows with the differing bits highlighted, plus named snapshots.
- **Templates and export:** built-in templates (IEEE-754, RGB565, IPv4…) or your own. Export fields as C macros, a C struct (split into 32 or 64-bit words), Rust or Python, or write your own export template for any language.
- **CMSIS-SVD import:** load a microcontroller's `.svd` file and add its registers as values, with fields, reset values, access and named values, or save them as templates.
- **Peripherals:** group registers into a block with a base address; each register shows its address, and the block exports as a C struct (with offset checks), C `#define`s or a Rust module. A sidebar lists them.
- **Workspace:** undo/redo, auto-save and crash restore, search as you type (Ctrl+F) across every peripheral, command palette (Ctrl+K). Large workspaces (tens of thousands of registers) stay fast.
- **Look:** light, dark and high-contrast themes, seven colour schemes, seven font pairings, accent colour, compact mode. Interface sounds are optional and off by default.

Press **F1** in the app for searchable help.

New to it? Read the illustrated [guide](docs/guide/01-bits-and-values.md) (also under Help › Guide in the app). Changes are tracked in the [changelog](CHANGELOG.md).

## Install

Download the latest build from [Releases](https://github.com/kernel-dev/bitviewer/releases/latest):

| Platform | File |
|---|---|
| Windows | `Bit.Viewer_*_x64-setup.exe`, or `*_x64-portable.zip` to run without installing |
| macOS (Apple Silicon / Intel) | `Bit.Viewer_*_aarch64.dmg` / `Bit.Viewer_*_x64.dmg` |
| Linux | `bitviewer_*_linux_x64.tar.gz` (the `bitviewer` program, a `.desktop` file and an icon) |

On Windows, installed copies update themselves (Help › Check for updates). On macOS and Linux the app tells you when a new version is out.

Coming from 2.x? Bit Viewer 3 picks up your settings and auto-saved session on its first start, and on Windows its installer replaces 2.x in place.

> [!NOTE]
> Builds are not code-signed. Windows SmartScreen may warn on first run ("More info" → "Run anyway"). On macOS, right-click the app → Open the first time; if it says the app is damaged, run `xattr -cr "/Applications/Bit Viewer.app"`.

## Build from source

You need [Rust](https://rustup.rs) (stable). On Windows you also need the Microsoft C++ Build Tools; on macOS, Xcode (for the Metal shaders). On Linux, install the libraries GPUI uses:

```bash
sudo apt-get install libasound2-dev libfontconfig-dev libwayland-dev libx11-xcb-dev \
  libxkbcommon-dev libxkbcommon-x11-dev libvulkan-dev libzstd-dev clang
```

Then:

```bash
cargo run --release           # build and start the app
cargo test --workspace        # every test (the app's run real windows on GPUI's test platform)
cargo clippy --workspace --all-targets
cargo fmt
```

`bitviewer FILE.bitview` opens a workspace; `bitviewer --count 90000 FILE` repeats its values to try a large workspace.

<details>
<summary>Publishing a release with auto-updates</summary>

Releases are built by GitHub Actions ([`.github/workflows/release.yml`](.github/workflows/release.yml)) for Windows, macOS and Linux.

1. Once: add the repository secret `TAURI_SIGNING_PRIVATE_KEY` with the contents of `~/.tauri/bitviewer.key` (the minisign key the updater checks; it is the same key 2.x used, so 2.x installs can update to 3). Add `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` only if the key has a password.
2. Bump `version` in the root `Cargo.toml`, add a `## [x.y.z] - YYYY-MM-DD` section to CHANGELOG.md, and commit.
3. Tag and push: `git tag v3.0.1 && git push origin v3.0.1`.

The workflow checks that the tag matches the version and that CHANGELOG.md has a section for it, builds every platform, signs the Windows installer and publishes the release with `latest.json` for the updater. The release notes (also shown in the app's "What's new") are that changelog section.

Every push to `main` and every pull request runs formatting, clippy and the tests on all three systems ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

Keep the signing key private and backed up: without it, installed copies can't verify future updates.

</details>

## Shortcuts

| Action | Keys |
|---|---|
| Add 32 / 64-bit / custom width | Ctrl+1 / Ctrl+2 / Ctrl+3 |
| Undo / redo | Ctrl+Z / Ctrl+Y (or Ctrl+Shift+Z) |
| Group selection into a field / clear selection | Ctrl+G / Esc |
| Find / command palette | Ctrl+F / Ctrl+K (or Ctrl+Shift+P) |
| New / open / save / save as | Ctrl+N / Ctrl+O / Ctrl+S / Ctrl+Shift+S |
| Zoom | Ctrl+wheel, Ctrl+= / Ctrl+- / Ctrl+0 |
| Toggle theme / settings / help | Ctrl+T / Ctrl+, / F1 |

## Project layout

<details>
<summary>Show</summary>

```
core/             the data model, with no UI (fast tests)
  src/              values, fields, rows, operations, expressions, integers and
                    readouts, undo history, workspaces and files, settings,
                    the session, templates, code export, CMSIS-SVD import
  templates/        the built-in code export templates
  tests/            export and SVD golden tests
app/              the GPUI app
  src/
    main.rs           start-up, the window
    workspace_view/   the window's content: toolbar, sidebar, search, peripherals,
                      open/save, drag to reorder, SVD import, the list's rows
    card/             one value: header, toolbar, bit tables, fields, readouts, menus
    fit.rs            text that fits the space layout gives it
    theme.rs, fonts.rs, widgets.rs, modal.rs   look and building blocks
    *_dialog.rs       settings, help, guide, export, templates, SVD picker…
    updates.rs        the in-app updater
    tests.rs          the interface tests
  assets/           icons (Lucide), fonts, the app icon
docs/guide/       illustrated guide (markdown + screenshots, shown in the app too)
packaging/        the Windows installer, the macOS app bundle, the Linux desktop entry
scripts/          release notes from CHANGELOG.md, the updater feed
```

</details>

## Credits

Built with [GPUI](https://www.gpui.rs) and [GPUI Component](https://github.com/longbridge/gpui-component). Icons by [Lucide](https://lucide.dev). The fonts (Outfit, Geist, Atkinson Hyperlegible, Inter, JetBrains Mono, IBM Plex, Source, Red Hat) are bundled so the app works offline; their licences are next to them in `app/assets/fonts`.

Versions up to 2.1.3 were a Tauri/TypeScript app; its last version is tagged `tauri-final`.

## License

[MIT](LICENSE)
