## Summary

<!-- What this changes and why, in a sentence or two. -->

## Changes

<!-- The main changes, grouped by area. Link issues with "Fixes #123". -->

-

## Screenshots

<!-- For anything you can see in the app: the new UI, or before and after.
     Drag PNGs into this box to attach them. Delete this section if nothing
     visible changed. -->

| Before | After |
| ------ | ----- |
|        |       |

## How to test

<!-- Steps a reviewer can follow in the app (`npm run tauri dev`). -->

1.

## Checks

- [ ] `npm run check` passes (types, lint, unit tests, Rust format, clippy and tests)
- [ ] `npm run test:e2e` passes
- [ ] CHANGELOG.md has an entry under **Unreleased** (or the release section)
- [ ] Guide pages updated if the UI changed, screenshots too (`npm run docs:shots`)
- [ ] For a release: version bumped in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`

## Notes for reviewers

<!-- Where to start reading, follow-ups, known gaps. -->
