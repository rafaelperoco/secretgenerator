// Checks on an assembled dist/<target>/ directory. Chrome refuses to load
// an extension with a broken manifest without saying why, and a missing
// module only shows up as a dead popup, so the build looks for these
// mistakes itself. Every check returns a list of problems; an empty list
// means it passed.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { BuildError, walkFiles } from "./common.mjs";

/**
 * Module specifiers of the static imports, re-exports and literal dynamic
 * imports in an ES module.
 *
 * This is pattern matching, not parsing. It relies on tsc (and both
 * wasm_exec.js shims) putting module-level statements at column 0, which
 * keeps prose in comments from being read as imports.
 */
export function importSpecifiers(source) {
  const patterns = [
    /^import\s*["']([^"'\n]+)["']/gm,
    /^import\b[^;"']*?\bfrom\s*["']([^"'\n]+)["']/gm,
    /^export\b[^;"'=()]*?\bfrom\s*["']([^"'\n]+)["']/gm,
    /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
  ];
  return patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]));
}

/**
 * Without a bundler the browser resolves every specifier as a URL: it
 * needs the real file name including ".js", and bare package names do not
 * resolve at all.
 */
export function checkImports(dir) {
  const files = new Set(walkFiles(dir));
  const problems = [];
  for (const file of files) {
    if (!file.endsWith(".js")) continue;
    for (const specifier of importSpecifiers(readFileSync(path.join(dir, file), "utf8"))) {
      const where = `${file}: import "${specifier}"`;
      let target;
      if (specifier.startsWith("./") || specifier.startsWith("../")) {
        target = path.posix.join(path.posix.dirname(file), specifier);
      } else if (specifier.startsWith("/") && !specifier.startsWith("//")) {
        target = specifier.slice(1);
      } else {
        problems.push(`${where} is not a relative path; the browser cannot resolve it`);
        continue;
      }
      if (!specifier.endsWith(".js")) problems.push(`${where} must end in .js`);
      else if (target.startsWith("../")) problems.push(`${where} points outside the extension`);
      else if (!files.has(target)) problems.push(`${where} does not resolve to a file`);
    }
  }
  return problems;
}

function manifestFiles(manifest) {
  const background = manifest.background ?? {};
  return [
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.action?.default_icon ?? {}),
    manifest.action?.default_popup,
    background.service_worker,
    ...(background.scripts ?? []),
    manifest.default_locale && `_locales/${manifest.default_locale}/messages.json`,
  ].filter((file) => typeof file === "string");
}

const present = (dir, file) => {
  const full = path.join(dir, file);
  return existsSync(full) && statSync(full).isFile();
};

export function checkManifestFiles(dir, manifest) {
  return [...new Set(manifestFiles(manifest))]
    .filter((file) => !present(dir, file))
    .map((file) => `manifest.json refers to "${file}", which is not in the build`);
}

/** Local files the popup page loads: scripts, stylesheets, images. */
export function checkPageReferences(dir, manifest) {
  const page = manifest.action?.default_popup;
  if (typeof page !== "string" || !present(dir, page)) return [];
  const html = readFileSync(path.join(dir, page), "utf8");
  const problems = [];
  for (const match of html.matchAll(/\s(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const reference = match[1] ?? match[2];
    // Fragments and URLs with a scheme are not files of this build. The
    // unit tests reject remote URLs separately.
    if (reference.startsWith("#") || /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(reference)) continue;
    const clean = reference.replace(/[?#].*$/, "");
    const target = clean.startsWith("/")
      ? clean.slice(1)
      : path.posix.join(path.posix.dirname(page), clean);
    if (target.startsWith("../") || !present(dir, target)) {
      problems.push(`${page} refers to "${reference}", which is not in the build`);
    }
  }
  return problems;
}

export function checkWasm(dir) {
  const problems = [];
  for (const file of ["wasm/keygen.wasm", "wasm/wasm_exec.js"]) {
    if (!present(dir, file)) problems.push(`${file} is missing`);
    else if (statSync(path.join(dir, file)).size === 0) problems.push(`${file} is empty`);
  }
  if (problems.length === 0) {
    const magic = readFileSync(path.join(dir, "wasm/keygen.wasm")).subarray(0, 4);
    if (magic.toString("latin1") !== "\0asm") {
      problems.push("wasm/keygen.wasm is not a WebAssembly module");
    }
  }
  return problems;
}

/**
 * Locale files must parse and define the same keys. A key missing from
 * one locale shows as an empty string in that language only, and a
 * __MSG_x__ reference without a message makes the manifest invalid.
 */
export function checkLocales(dir, manifest) {
  const problems = [];
  const locales = new Map();
  for (const file of walkFiles(dir)) {
    const match = /^_locales\/([^/]+)\/messages\.json$/.exec(file);
    if (!match) continue;
    try {
      const messages = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
      for (const [key, entry] of Object.entries(messages)) {
        if (typeof entry?.message !== "string") problems.push(`${file}: "${key}" has no message`);
      }
      locales.set(match[1], new Set(Object.keys(messages)));
    } catch (error) {
      problems.push(`${file}: ${error.message}`);
    }
  }

  const reference = manifest.default_locale;
  const expected = locales.get(reference);
  if (!expected) return problems;
  for (const [locale, keys] of locales) {
    for (const key of expected) {
      if (!keys.has(key)) problems.push(`_locales/${locale}: missing "${key}"`);
    }
    for (const key of keys) {
      if (!expected.has(key)) {
        problems.push(`_locales/${locale}: "${key}" is not in _locales/${reference}`);
      }
    }
  }
  for (const match of JSON.stringify(manifest).matchAll(/__MSG_([A-Za-z0-9_@]+)__/g)) {
    if (!expected.has(match[1])) {
      problems.push(`manifest.json uses __MSG_${match[1]}__, which _locales/${reference} lacks`);
    }
  }
  return problems;
}

/** Runs every check on one dist/<target>/ directory. */
export function verifyDist(dir) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
  } catch (error) {
    return [`manifest.json: ${error.message}`];
  }
  return [
    ...checkManifestFiles(dir, manifest),
    ...checkPageReferences(dir, manifest),
    ...checkWasm(dir),
    ...checkImports(dir),
    ...checkLocales(dir, manifest),
  ];
}

/** Fails with the full list when verifyDist finds anything. */
export function requireValidDist(dir, label) {
  const problems = verifyDist(dir);
  if (problems.length > 0) {
    throw new BuildError(
      `${label} failed verification:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`,
    );
  }
}
