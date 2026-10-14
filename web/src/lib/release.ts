import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const manifestPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../.release-please-manifest.json",
);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, string>;
const raw = manifest["."];
if (!raw) {
  throw new Error(`missing "." version in ${manifestPath}`);
}

// Header, install snippets, and JSON-LD all use this. release-please
// writes the manifest in the release pull request, and web-deploy runs
// when that file changes.
export const releaseVersion = raw.startsWith("v") ? raw : `v${raw}`;
