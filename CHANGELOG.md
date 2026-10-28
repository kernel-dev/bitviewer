# Changelog

All notable changes to Bit Viewer are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [semantic versioning](https://semver.org/).

Add each change under **Unreleased** as you make it. When a version is released, rename that section to `## [x.y.z] - YYYY-MM-DD` and start a new empty **Unreleased** above it. Keep that exact heading format: the release script and workflow use the section as the release notes, and the app shows it in its "What's new" dialog.

## [Unreleased]

### Changed
- CMSIS-SVD import: register arrays (`dim`) of any size now work. They used to be cut off after 1,024 copies. An array is one row in the picker, such as `CCR[0-3]`: tick it for every copy, open it to tick single copies, or type which copies you want (`0-7, 12`). Only the copies you pick are made, so even an array of millions opens instantly, including arrays nested in clusters and peripherals. Importing more than 50 registers asks first, for templates too.
- The app opens files up to 512 MB (was 64 MB).
- Large workspaces use far less memory and respond faster. With about 90,000 values the app used to grow by around 100 MB with every edit (each undo step kept a full copy of the workspace) and could pass 6 GB; it now stays near 1.2 GB however much you edit. Undo steps share everything that didn't change, and undo history is also capped at about 256 MB. Values that are off screen no longer hold their elements: before, every value kept a hidden set of readout chips (4.4 million page elements for 90,000 values), and values you had scrolled past kept all of theirs. An edit takes a few milliseconds instead of about half a second, an undo well under a second instead of 4–5 seconds, and opening is about twice as fast.
- When the open workspace is saved and unchanged, the auto-saved session only remembers the file instead of a full copy of it, and the session is written without being copied and escaped on the way.
- CMSIS-SVD import: the file's text is let go as soon as it is read, instead of staying in memory while you pick registers.

### Fixed
- CMSIS-SVD import: a `dimIndex` letter range with more copies than letters (such as `A-Z` for 30 copies) made names with symbols after `Z`. Those copies are now numbered from 0, with a note. A `dimIndex` that doesn't match the dim is noted too.

## [2.1.3] - 2026-10-26

### Added
- Peripherals: group values into a block with a name, base address and description (a value's ⋯ › Peripheral). Each register shows its address (base + offset) and can be moved, sorted by offset or collapsed with its block. **Export** on a peripheral writes a C struct with every register at its offset and `_Static_assert` checks, C `#define`s for the addresses, or a Rust module. SVD imports now create peripherals automatically. New guide page "Peripherals"; workspaces from older versions open unchanged, and older versions can still open new files (without the grouping).
- Values can have a description (⋯ › Add description…), shown when you point at the name.
- Export code: single registers in a peripheral also get their address (`_ADDR` in C and Python, `ADDR` in Rust). Templates can use `@scope peripheral`, the peripheral data (`registers`, `layout`, `base`…), the register's `address` and `offset`, and a new `lead(text)` filter.
- Import from CMSIS-SVD: **File › Import CMSIS-SVD…** (or drop a `.svd` file on the window) reads a microcontroller's register description. Pick peripherals or single registers and add them as values (named after the register, set to its reset value, with fields, descriptions, access and named values), or save them as templates. Handles inherited properties, `derivedFrom`, `dim` arrays, clusters and don't-care enumerated values. New guide page "Importing CMSIS-SVD".
- Export templates: a `rust_ident` filter that escapes Rust keywords (`type` → `r#type`).
- Forms (field details, the template editor, the SVD picker) ask before Esc, the X or a click outside throws away your changes.
- A message instead of a blank window when the app fails to start, and a notice when something goes wrong while it runs.
- CI: every push and pull request runs the checks and the end-to-end tests. Release builds run the end-to-end tests too, and `npm run check` runs the Rust tests.

### Changed
- Read-only and reserved fields now ask before *any* change to their bits: typing a value, operations, the expression bar, pasting bytes, named values, restoring a snapshot and the float chips, not only clicks. Painting still skips them.
- Workspaces saved by a newer version of the file format ask before opening.
- The app only opens `.bitview`, `.json`, `.svd` and `.xml` files (up to 64 MB) and won't write program files such as `.exe` or `.bat`.
- Dialogs keep keyboard focus inside them, and messages are announced to screen readers.
- Descriptions say 1–512 bits instead of 32/64-bit.
- Large workspaces are much faster and stay responsive: opening the 1,540 registers of an STM32F407 takes a tenth of a second instead of over two minutes, everything you do there shows within a frame or two, and importing many SVD registers no longer slows down with each one. Only the values on or near the screen are built (a large workspace used to hold over a million page elements, which made the whole app sluggish); the others are built as you scroll to them. Jumping to a value far away no longer scrolls smoothly past all the others.
- The lock in front of a read-only or reserved field explains itself when you point at it.
- Search (Ctrl+F) runs when you press Enter or **Search** instead of on every keystroke, so typing stays smooth in large workspaces. Enter again goes to the next match; clearing the box shows everything again.
- CMSIS-SVD import: every register starts selected, and a **Select all / Unselect all** button toggles them all at once. With a filter typed, it acts on the matching registers only.
- **⋯ › Compare with…** opens a dialog: type any number or expression to compare with (`x` is the value itself), or pick another value from a filterable list. Also in the command palette.
- Internal: the source is reorganised into small modules by topic (the value model, the UI kit, the card, the main window and the stylesheet were each one large file). Nothing changes for users.

### Fixed
- Undo, auto-save and the unsaved-changes prompt stopped working for the rest of the session if an Alt+drag paint stroke was interrupted (for example by Alt+Tab), so closing the app could lose work without asking.
- Esc in a dialog opened from another dialog (such as the template editor over Export code) closed both.
- Export code: Rust fields named after a keyword (`type`, `match`…) didn't compile; the C struct header lacked `#include <stdint.h>`; C headers had no include guards; the C `_SET` macros shifted the value as an `int`, which is wrong for fields above bit 31; named values such as "On" and "ON", or one called "Mask", produced clashing names; negative named values printed as `0x-1`.
- Workspace files with bit positions that aren't whole numbers, invalid row bases or colours that aren't `#rrggbb` are rejected or repaired instead of breaking later. Named values that don't fit their field are dropped (negative ones become two's complement).
- Expressions: powers of negative numbers such as `(-3) ** 100000000` could freeze the app; unit formulas treated `constructor` and similar words as names; shifts in unit formulas had no limit; `0x_` gave an internal error.
- Export templates: errors while printing a value now say which line they are on, and text that keeps doubling in a loop is stopped with a message.
- "What's new" is in the Help menu, as the notes for 2.1.2 said.
- The release workflow now really uses CHANGELOG.md for the release notes; `npm run release` writes them to a file for `gh release create --notes-file`.
- macOS: opening a workspace from Finder ("Open with" or double-click) now loads it. Windows / Linux: a workspace passed with a relative path by a second launch opens from the right folder.
- Dropping a folder or an unreadable file shows a message instead of failing silently.
- Applying a wider template and then cancelling "Replace fields?" no longer leaves the value widened.
- "Save fields as template" asks before replacing a template with the same name.
- Installing an update asks about unsaved changes and saves the session first.
- Right-click in the template editor shows the usual copy / paste menu.
- Paste bytes: Python literals with escapes such as `b'\n\t\\'` are read correctly.
- Cancelling the custom colour picker no longer leaves a hidden element behind.
- A submenu with no room to the right of its menu now opens on the left instead of covering the menu.

## [2.1.2] - 2026-10-21

### Added
- "What's new" dialog: after an update the app shows that version's changes from this changelog, once. Reopen it from Help › What's new (or the command palette).
- Release notes now come from the version's section of this changelog (`npm run release` and the release workflow), so the update prompt shows the same text. `--notes` still overrides it.
- Export templates: values, masks and named values are numbers with `.hex`, `.bin`, `.dec` and `.oct` (for example `${value.bin}` gives `0b0111111111111111`). `${value}` on its own still prints hex. Fields also have a `value` holding what they contain right now.
- Export templates: write your own code export in a small template language (`${value}` placeholders plus `@for`, `@if` and `@set` lines) for any language or format. Use **+** in the Export code dialog; the editor has a live preview and reports mistakes with line numbers. Your templates are saved with your settings.
- Export code: **Register width** (32-bit or 64-bit). Values wider than a register are split into words: `lower` / `upper` for two, `1`, `2`, `3`… for more. Fields that cross a word boundary are split into `_PART1`, `_PART2`… pieces. Each word uses the smallest integer type that fits.
- Export code: the C struct export now handles registers of any width, and writes a combined struct when there are several words.
- Guide pages "Generating code" and "Export templates" (full language reference), with screenshots.
- Export code: a **Layout** comment at the top of every file that lists the fields from the top bit down, with access, formula and description.
- Export code: **Get / set helpers** switch, to emit only positions and masks.

### Changed
- Internal: descriptive names throughout the code (a `ValueModel` is `model`, a `Group` is `group`, `S` is `appSettings`, `h()` is `html()`, and so on) instead of one- and two-letter abbreviations. Saved workspaces, settings and the `lo` / `hi` bit-range terms are unchanged.
- Export templates: the built-in templates and the docs now use descriptive loop variables (`field`, `word`, `item`, `named_value`) instead of `f`, `w`, `it`, `n`. Templates you wrote keep working, because you choose your own names.
- Export code: the built-in C macros, C struct, Rust and Python outputs are now export templates written in the same language. Open one with the pencil button to see how it works or to make your own copy.
- Export code: the name prefix defaults to `REG` for values still called "Value 1", "Value 2"…, instead of `VALUE_1`.
- Export code: **Copy** keeps the dialog open so you can switch language and copy again; there is a separate **Close** button.
- Export code: the dialog explains what each language gives you, and the options have clearer names ("Name prefix", "Current value").

### Fixed
- Export code: fields whose names clash after conversion to identifiers (for example `Mode` and `MODE`) get `_2`, `_3`… suffixes instead of producing duplicate definitions.

## [2.1.1] - 2026-10-20

### Added
- Guide: short illustrated pages (bits and values, expressions, register fields, operations and compare, templates and workspace) in `docs/guide`, readable on GitHub and in the app under Help › Guide.
- `npm run docs:shots` regenerates the guide's screenshots from the real UI.
- Resize a field: right-click one of its bits and choose "Resize to selection" to widen, narrow or move it. It keeps its name, colour and details, and refuses to overlap another field.

### Changed
- F1 help is now a short quick reference. Each topic links to the matching guide page, and there is an "Open the guide" button.
- The expression bar's result preview now updates live as bits and fields change, not only while typing.

## [2.1.0] - 2026-10-19

### Added
- Undo/redo, automatic session restore and a settings file.
- Number tools: more operations (rotate, arithmetic shift, swap bytes, reverse bits, mask operations), expressions, editable float chips, paste/copy bytes and extra readouts.
- Field details (description, signedness, formulas with units, named values, access), templates and code export (C, Rust, Python).
- Workspace features: reorder and collapse values, recent files, search, command palette, snapshots, compare rows.
- Keyboard control of bits, paint mode, accessibility improvements, accent colours, help and a first-run tour.
- File association, single instance and auto-updates.
- End-to-end test suite (Playwright) and a release workflow for Windows, macOS and Linux.

### Changed
- Source reorganised into `core`, `app`, `card`, `ui` and `dialogs` folders.
- README rewritten with a screenshot, notice and licence.

### Fixed
- The field-bar layer no longer covers the bottom of bit cells.

## [2.0.0]

### Added
- Tauri app baseline: inspect and edit values of 1 to 512 bits, bit by bit.

[Unreleased]: https://github.com/kernel-dev/bitviewer/compare/v2.1.2...HEAD
[2.1.2]: https://github.com/kernel-dev/bitviewer/releases/tag/v2.1.2
[2.1.1]: https://github.com/kernel-dev/bitviewer/releases/tag/v2.1.1
[2.1.0]: https://github.com/kernel-dev/bitviewer/releases/tag/v2.1.0
