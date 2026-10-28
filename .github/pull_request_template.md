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

<!-- Steps a reviewer can follow in the app (`cargo run --release`). -->

1.

## Checks

- [ ] `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings` and `cargo test --workspace` pass
- [ ] CHANGELOG.md has an entry under **Unreleased** (or the release section)
- [ ] Guide pages updated if the UI changed, screenshots too
- [ ] For a release: version bumped in the root `Cargo.toml`

## Notes for reviewers

<!-- Where to start reading, follow-ups, known gaps. -->
