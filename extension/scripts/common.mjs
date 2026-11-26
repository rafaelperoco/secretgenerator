// Helpers shared by the build tooling. Node built-ins only: the tooling
// has to run on a fresh checkout after nothing more than `npm ci`.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TARGETS } from "./manifest.mjs";

export const EXT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The WASM core is the Go package ./web/wasm of the repository root module.
export const REPO_ROOT = path.resolve(EXT_ROOT, "..");

/** An expected failure: printed as one message, without a stack trace. */
export class BuildError extends Error {}

/** Expands the --target value into a list of targets. */
export function resolveTargets(value) {
  if (value === "all") return [...TARGETS];
  if (TARGETS.includes(value)) return [value];
  throw new BuildError(`unknown target "${value}" (expected chrome, firefox or all)`);
}

export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new BuildError(`${file}: ${error.message}`);
  }
}

/**
 * Every file under dir as a "/"-separated relative path. The order is by
 * code unit rather than by locale, so it is the same on every machine: the
 * zip entry order, and with it the zip's hash, depends on it.
 */
export function walkFiles(dir) {
  const out = [];
  const visit = (sub) => {
    for (const entry of readdirSync(path.join(dir, sub), { withFileTypes: true })) {
      const rel = sub ? `${sub}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(rel);
      else if (entry.isFile()) out.push(rel);
      // A symlink would ship whatever it happens to point at on this machine.
      else throw new BuildError(`${path.join(dir, rel)}: not a regular file`);
    }
  };
  visit("");
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Runs a CLI entry point and turns a BuildError into exit status 1. */
export function runCli(name, main) {
  Promise.resolve()
    .then(main)
    .catch((error) => {
      if (error instanceof BuildError) console.error(`[${name}] error: ${error.message}`);
      else console.error(error);
      process.exitCode = 1;
    });
}
