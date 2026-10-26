import { describe, expect, it } from "vitest";
import changelogText from "../../CHANGELOG.md?raw";
import pkg from "../../package.json";
import { findRelease, parseChangelog } from "../../src/core/changelog";

const SAMPLE = `# Changelog

## [Unreleased]

### Added
- Not released yet.

## [2.1.0] - 2026-10-19

### Added
- First thing, with \`code\`.
- Second thing that wraps
  onto a second line.

### Fixed
- A bug.

## [2.0.0]

- Loose item.

[Unreleased]: https://example.com/compare/v2.1.0...HEAD
[2.1.0]: https://example.com/releases/tag/v2.1.0
`;

describe("parseChangelog", () => {
  it("skips Unreleased and reads versions with and without a date", () => {
    expect(parseChangelog(SAMPLE).map((r) => [r.version, r.date])).toEqual([
      ["2.1.0", "2026-10-19"],
      ["2.0.0", ""],
    ]);
  });

  it("groups bullets under their ### heading and joins wrapped lines", () => {
    const release = findRelease(SAMPLE, "2.1.0");
    expect(release?.sections).toEqual([
      {
        title: "Added",
        items: [
          "First thing, with `code`.",
          "Second thing that wraps onto a second line.",
        ],
      },
      { title: "Fixed", items: ["A bug."] },
    ]);
  });

  it("keeps bullets that come before any ### heading", () => {
    expect(findRelease(SAMPLE, "2.0.0")?.sections).toEqual([
      { title: "", items: ["Loose item."] },
    ]);
  });

  it("does not treat the link lines at the end as part of the last bullet", () => {
    const items = findRelease(SAMPLE, "2.0.0")?.sections[0].items;
    expect(items).toEqual(["Loose item."]);
  });

  it("returns undefined for a version with no entry", () => {
    expect(findRelease(SAMPLE, "9.9.9")).toBeUndefined();
  });
});

describe("CHANGELOG.md", () => {
  it("has a non-empty entry for the current app version, unless it is unreleased", () => {
    const release = findRelease(changelogText, pkg.version);
    expect(release, `no "## [${pkg.version}] - date" heading`).toBeDefined();
    expect(release?.sections.some((s) => s.items.length > 0)).toBe(true);
  });
});
