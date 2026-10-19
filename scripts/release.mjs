// Builds a signed release and writes latest.json for the auto-updater.
//
//   npm run release -- --notes "What changed"
//
// Needs the private key from `tauri signer generate` at ~/.tauri/bitviewer.key
// (or TAURI_SIGNING_PRIVATE_KEY set), and the updater endpoint in
// src-tauri/tauri.conf.json pointing at your GitHub repo.
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const conf = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const version = conf.version;
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const notes = flag("--notes") ?? `Bit Viewer ${version}`;

// Asset URLs live next to latest.json: https://github.com/OWNER/REPO/releases/download/vX.Y.Z/<file>
const endpoint = conf.plugins?.updater?.endpoints?.[0] ?? "";
const repo = flag("--repo") ?? /github\.com\/([^/]+\/[^/]+)\/releases/.exec(endpoint)?.[1];
if (!repo || repo === "OWNER/REPO") {
  console.error(
    "Set your GitHub repo first: in src-tauri/tauri.conf.json replace OWNER/REPO in plugins.updater.endpoints\n" +
      "(e.g. https://github.com/you/bitviewer/releases/latest/download/latest.json), or pass --repo you/bitviewer.",
  );
  process.exit(1);
}

const keyPath = join(homedir(), ".tauri", "bitviewer.key");
const env = { ...process.env };
if (!env.TAURI_SIGNING_PRIVATE_KEY) {
  if (!existsSync(keyPath)) {
    console.error(`No signing key: expected ${keyPath} (run: npx tauri signer generate -w "${keyPath}")`);
    process.exit(1);
  }
  env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(keyPath, "utf8");
  env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= "";
}

console.log(`Building Bit Viewer ${version} with updater artifacts…`);
execSync("npx tauri build --config src-tauri/tauri.updater.conf.json", {
  cwd: root,
  env,
  stdio: "inherit",
});

const nsisDir = join(root, "src-tauri", "target", "release", "bundle", "nsis");
const installer = readdirSync(nsisDir).find((f) => f.includes(version) && f.endsWith("-setup.exe"));
if (!installer || !existsSync(join(nsisDir, `${installer}.sig`))) {
  console.error(`Couldn't find the signed installer for ${version} in ${nsisDir}`);
  process.exit(1);
}
const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature: readFileSync(join(nsisDir, `${installer}.sig`), "utf8").trim(),
      url: `https://github.com/${repo}/releases/download/v${version}/${encodeURIComponent(installer).replace(/%20/g, ".")}`,
    },
  },
};
const out = join(root, "src-tauri", "target", "release", "bundle", "latest.json");
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`\nWrote ${out}`);
console.log("\nPublish the release (GitHub CLI):");
console.log(
  `  gh release create v${version} --repo ${repo} --title "Bit Viewer ${version}" --notes ${JSON.stringify(notes)} ` +
    `"${join(nsisDir, installer)}" "${out}"`,
);
console.log("\nNote: GitHub replaces spaces in asset names with dots; the URL above already accounts for that.");
