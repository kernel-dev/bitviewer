// Writes the updater feed (latest.json) for a release, to stdout.
//
//   node scripts/latest-json.mjs v3.0.0 release-files > release-files/latest.json
//
// The folder holds the release files, with the Windows installer's minisign
// signature next to it (*-setup.exe.sig, from `tauri signer sign`).
//
// The installer is listed twice: as "windows-x86_64-native" for this app's
// updater, and as "windows-x86_64" for 2.x (Tauri) installs, so their
// updater moves them to this app (the installer replaces the 2.x app in place).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readReleaseNotes } from "./changelog.mjs";

const [tag, folder] = process.argv.slice(2);
if (!tag || !folder) {
  console.error("usage: node scripts/latest-json.mjs <tag> <folder>");
  process.exit(1);
}
const version = tag.replace(/^v/, "");
const repo = process.env.GITHUB_REPOSITORY ?? "kernel-dev/Bitviewer";
const files = readdirSync(folder);
const setup = files.find((file) => file.endsWith("-setup.exe"));
if (!setup || !files.includes(`${setup}.sig`)) {
  console.error(`${folder} needs the Windows installer and its .sig`);
  process.exit(1);
}
const windows = {
  signature: readFileSync(join(folder, `${setup}.sig`), "utf8").trim(),
  url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(setup)}`,
};
const feed = {
  version,
  notes: readReleaseNotes(version) ?? "",
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64-native": windows,
    "windows-x86_64": windows,
  },
};
console.log(JSON.stringify(feed, null, 2));
