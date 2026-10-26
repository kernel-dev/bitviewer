// Reads CHANGELOG.md (Keep a Changelog format). Release headings look like
// `## [2.1.0] - 2026-10-19`; `[Unreleased]` and the link lines at the bottom
// are skipped. scripts/changelog.mjs does the same job for the release scripts.

export interface ChangelogSection {
  /** "Added", "Changed", "Fixed"… (empty when items come before any `###` heading). */
  title: string;

  items: string[];
}

export interface ChangelogRelease {
  version: string;

  /** "YYYY-MM-DD", or "" when the heading has no date. */
  date: string;

  sections: ChangelogSection[];
}

const RELEASE_HEADING =
  /^##\s+\[(\d+\.\d+\.\d+[^\]\s]*)\](?:\s+-\s+(\d{4}-\d{2}-\d{2}))?\s*$/;

const LINK_REFERENCE = /^\[[^\]]+\]:\s/;

export function parseChangelog(text: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = [];
  let release: ChangelogRelease | null = null;
  let section: ChangelogSection | null = null;
  let item = -1;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.startsWith("## ")) {
      const heading = RELEASE_HEADING.exec(line);
      release = heading
        ? { version: heading[1], date: heading[2] ?? "", sections: [] }
        : null;
      if (release) releases.push(release);
      section = null;
      item = -1;
    } else if (!release || LINK_REFERENCE.test(line)) {
      // outside a release (preamble, [Unreleased]) or a link line: ignore
    } else if (line.startsWith("### ")) {
      section = { title: line.slice(4).trim(), items: [] };
      release.sections.push(section);
      item = -1;
    } else if (/^[-*]\s/.test(line)) {
      if (!section) {
        section = { title: "", items: [] };
        release.sections.push(section);
      }

      section.items.push(line.slice(2).trim());
      item = section.items.length - 1;
    } else if (line.trim() && section && item >= 0) {
      section.items[item] += ` ${line.trim()}`; // wrapped continuation of the bullet above
    }
  }

  return releases;
}

/** The entry for `version`, or undefined when the changelog has none. */
export function findRelease(
  text: string,
  version: string,
): ChangelogRelease | undefined {
  return parseChangelog(text).find((release) => release.version === version);
}
