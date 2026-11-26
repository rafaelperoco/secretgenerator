#!/usr/bin/env node
// Zips dist/<target>/ into artifacts/ for the extension stores.
//
//   node scripts/package.mjs [--target chrome|firefox|all] [--allow-dev-build]
//
// Run `npm run build` first. The zips are deterministic (see zip.mjs), so
// anyone with the same toolchain can reproduce them from the source tree
// and compare the checksums in artifacts/SHA256SUMS.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  BuildError,
  EXT_ROOT,
  readJson,
  resolveTargets,
  runCli,
  sha256,
  walkFiles,
} from "./common.mjs";
import { parseVersion } from "./manifest.mjs";
import { requireValidDist } from "./verify.mjs";
import { createZip, zipTimestamp } from "./zip.mjs";

const USAGE = "usage: node scripts/package.mjs [--target chrome|firefox|all] [--allow-dev-build]";

const BUILD_INFO = path.join(EXT_ROOT, "build", "wasm", "build-info.json");
const ARTIFACTS = path.join(EXT_ROOT, "artifacts");
const NAME = "secretgenerator-extension";

const log = (message) => console.log(`[package] ${message}`);

function readOptions() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        target: { type: "string", default: "all" },
        "allow-dev-build": { type: "boolean", default: false },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (error) {
    throw new BuildError(`${error.message}\n${USAGE}`);
  }
  if (values.help) return { help: true };
  return { targets: resolveTargets(values.target), allowDevBuild: values["allow-dev-build"] };
}

function readBuildInfo(allowDevBuild) {
  if (!existsSync(BUILD_INFO)) {
    throw new BuildError("build/wasm/build-info.json is missing. Run `npm run build` first.");
  }
  const info = readJson(BUILD_INFO);
  if (info.compiler !== "tinygo") {
    if (!allowDevBuild) {
      throw new BuildError(
        `the WASM core was built with "${info.compiler}", not TinyGo: this is a development build.\n` +
          "Release packages must be built with TinyGo (npm run build -- --compiler tinygo).\n" +
          "Pass --allow-dev-build to package it anyway, for local testing only.",
      );
    }
    console.warn(
      "[package] WARNING: packaging a DEVELOPMENT build (standard Go). Do not publish it.",
    );
  }
  return info;
}

/**
 * dist/<target>/ must be the output of the build that build-info.json
 * describes. A later build of only the other target, with another compiler
 * or another --version, replaces build-info.json and leaves this directory
 * alone. Its zip would then get the wrong name, or contain a core that the
 * development-build check never looked at.
 */
function checkCurrent(target, dist, info, version) {
  const stale = (what) =>
    new BuildError(`dist/${target} is out of date (${what}). Run \`npm run build\` again.`);
  if (readJson(path.join(dist, "manifest.json")).version !== version.manifest) {
    throw stale(`its manifest version is not ${version.manifest}`);
  }
  for (const file of ["keygen.wasm", "wasm_exec.js"]) {
    const shippedFile = path.join(dist, "wasm", file);
    if (!existsSync(shippedFile) || sha256(readFileSync(shippedFile)) !== info.sha256?.[file]) {
      throw stale(`wasm/${file} differs from build/wasm/${file}`);
    }
  }
}

function zipTarget(target, info, version, epochSeconds) {
  const dist = path.join(EXT_ROOT, "dist", target);
  if (!existsSync(path.join(dist, "manifest.json"))) {
    throw new BuildError(`dist/${target} is missing. Run \`npm run build\` first.`);
  }
  checkCurrent(target, dist, info, version);
  // Again, although the build did it: dist/ may have been edited by hand.
  requireValidDist(dist, `dist/${target}`);

  // Paths are relative to dist/<target>/, which puts manifest.json at the
  // zip root. Both stores reject an archive that wraps it in a folder.
  const files = walkFiles(dist).map((name) => ({
    name,
    data: readFileSync(path.join(dist, name)),
  }));
  return {
    name: `${NAME}-${version.full}-${target}.zip`,
    data: createZip(files, { epochSeconds }),
    count: files.length,
  };
}

// Lists every package in artifacts/, not only the ones written by this
// run, so that `sha256sum -c SHA256SUMS` holds after packaging one target.
function writeChecksums() {
  const lines = readdirSync(ARTIFACTS)
    .filter((file) => file.startsWith(`${NAME}-`) && file.endsWith(".zip"))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((file) => `${sha256(readFileSync(path.join(ARTIFACTS, file)))}  ${file}\n`);
  writeFileSync(path.join(ARTIFACTS, "SHA256SUMS"), lines.join(""));
  log(`artifacts/SHA256SUMS: ${lines.length} entr${lines.length === 1 ? "y" : "ies"}`);
}

runCli("package", () => {
  const options = readOptions();
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const info = readBuildInfo(options.allowDevBuild);
  let version;
  let epochSeconds;
  try {
    version = parseVersion(info.version);
    epochSeconds = zipTimestamp();
  } catch (error) {
    throw new BuildError(error.message);
  }
  // Every target is checked before anything is written: a failure must not
  // leave artifacts/ with one new package and one from an earlier build.
  const zips = options.targets.map((target) => zipTarget(target, info, version, epochSeconds));
  mkdirSync(ARTIFACTS, { recursive: true });
  for (const zip of zips) {
    writeFileSync(path.join(ARTIFACTS, zip.name), zip.data);
    log(`artifacts/${zip.name}: ${zip.count} files, ${zip.data.length} bytes`);
  }
  writeChecksums();
});
