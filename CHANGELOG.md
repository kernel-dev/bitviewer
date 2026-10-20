# Changelog

All notable changes to Bit Viewer are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [semantic versioning](https://semver.org/).

Add each change under **Unreleased** as you make it. When a version is released, rename that section to the version and date, and start a new empty **Unreleased** above it.

## v2.1.1

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

[Unreleased]: https://github.com/kernel-dev/bitviewer/compare/v2.1.0...HEAD
[2.1.0]: https://github.com/kernel-dev/bitviewer/releases/tag/v2.1.0
