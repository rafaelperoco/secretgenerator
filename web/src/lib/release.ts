import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Astro bundles this module into web/dist, so a path relative to
// import.meta.url does not reach the repo root. `npm run build` runs
// with cwd = web/.
const candidates = [
  join(process.cwd(), "..", ".release-please-manifest.json"),
  join(process.cwd(), ".release-please-manifest.json"),
];
const manifestPath = candidates.find((path) => existsSync(path));
if (!manifestPath) {
  throw new Error(`release-please manifest not found. tried ${candidates.join(", ")}`);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, string>;
const raw = manifest["."];
if (!raw) {
  throw new Error(`missing "." version in ${manifestPath}`);
}

// Header, install snippets, and JSON-LD all use this. release-please
// writes the manifest in the release pull request, and web-deploy runs
// when that file changes.
export const releaseVersion = raw.startsWith("v") ? raw : `v${raw}`;
