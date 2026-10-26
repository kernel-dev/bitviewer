// Pulls one version's notes out of CHANGELOG.md, for the release script and workflow.
//
//   node scripts/changelog.mjs 2.1.1     prints the notes; exits 1 if there are none
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const changelogPath = join(import.meta.dirname, "..", "CHANGELOG.md");

/** The text under `## [version] - date`, up to the next release or the link lines. */
export function releaseNotes(text, version) {
  const heading = new RegExp(
    `^##\\s+\\[${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\](\\s+-\\s+\\d{4}-\\d{2}-\\d{2})?\\s*$`,
  );
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) return null;
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ") || /^\[[^\]]+\]:\s/.test(line)) break;
    body.push(line);
  }
  const notes = body.join("\n").trim();
  return notes || null;
}

export function readReleaseNotes(version) {
  return releaseNotes(readFileSync(changelogPath, "utf8"), version);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = process.argv[2];
  const notes = version ? readReleaseNotes(version) : null;
  if (!notes) {
    console.error(`CHANGELOG.md has no entry "## [${version ?? "x.y.z"}] - YYYY-MM-DD" with changes under it.`);
    process.exit(1);
  }
  console.log(notes);
}
