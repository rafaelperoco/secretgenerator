// What actually ships: the content of dist/<target>/ after `npm run build`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { readJson, sha256, walkFiles } from "../../scripts/common.mjs";
import { TARGETS, buildManifest } from "../../scripts/manifest.mjs";
import { importSpecifiers, verifyDist } from "../../scripts/verify.mjs";
import { fromRoot } from "./helpers.mjs";

const REQUIRED = [
  "manifest.json",
  "background.js",
  "popup/popup.html",
  "popup/popup.css",
  "popup/popup.js",
  "lib/badge.js",
  "lib/fill-flow.js",
  "lib/fill.js",
  "lib/generate.js",
  "lib/i18n.js",
  "lib/inject.js",
  "lib/notice.js",
  "lib/settings.js",
  "lib/wasm.js",
  "wasm/keygen.wasm",
  "wasm/wasm_exec.js",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "icons/icon-96.png",
  "icons/icon-128.png",
  "_locales/en/messages.json",
  "_locales/pt_BR/messages.json",
];

// The shim is the toolchain's file, shipped unmodified, and it does log.
// Everything else is this project's code.
const SHIM = "wasm/wasm_exec.js";

// Things the extension has no reason to contain. This is a text search on
// purpose, comments included: wording a comment differently costs nothing,
// and the search cannot be fooled by how the code is written.
const FORBIDDEN = [
  // Extension pages and the background context stay silent: a log line is
  // one edit away from containing a generated value.
  "console.",
  // Markup is built with DOM calls and textContent only.
  "innerHTML",
  "outerHTML",
  "insertAdjacentHTML",
  "document.write",
  // The CSP blocks these; code that needs them is broken.
  "eval(",
  "new Function",
  // No messaging surface: nothing may be able to ask for a value.
  "onMessage",
  "onConnect",
  // No network access. fetch() is used once, for the packaged WASM file.
  /fetch\(\s*["'`]\s*(?:https?:)?\/\//,
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "sendBeacon",
  // Chrome defines `browser` too, so the test tells nothing about the
  // browser. Firefox is detected through the extension's URL scheme.
  "typeof browser",
];

const found = (text, needle) =>
  typeof needle === "string" ? text.includes(needle) : needle.test(text);

/** Width and height from the IHDR chunk, which always comes first. */
function pngSize(file) {
  const png = readFileSync(file);
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `${file}: PNG signature`);
  assert.equal(png.toString("latin1", 12, 16), "IHDR", file);
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

const buildInfoFile = fromRoot("build", "wasm", "build-info.json");
assert.ok(
  existsSync(buildInfoFile),
  "build/wasm/build-info.json is missing. Run `npm run build` first.",
);
const buildInfo = readJson(buildInfoFile);

for (const target of TARGETS) {
  describe(`dist/${target}`, () => {
    const dist = fromRoot("dist", target);
    assert.ok(existsSync(dist), `dist/${target} is missing. Run \`npm run build\` first.`);
    const files = walkFiles(dist);
    const read = (file) => readFileSync(path.join(dist, file), "utf8");
    const ownScripts = files.filter((file) => file.endsWith(".js") && file !== SHIM);

    test("contains every required file", () => {
      for (const file of REQUIRED) assert.ok(files.includes(file), file);
    });

    test("contains only the documented layout", () => {
      for (const file of files) {
        assert.match(
          file,
          /^(manifest\.json|background\.js|(popup|lib)\/[^/]+\.(js|html|css)|wasm\/(keygen\.wasm|wasm_exec\.js)|icons\/icon-\d+\.png|_locales\/[A-Za-z_]+\/messages\.json)$/,
          `unexpected file ${file}`,
        );
      }
    });

    test("ships no sources, source maps, declarations or dotfiles", () => {
      for (const file of files) {
        assert.doesNotMatch(file, /\.(map|ts|svg)$/, file);
        assert.doesNotMatch(file, /(^|\/)\./, file);
        assert.notEqual(path.posix.basename(file), "build-info.json");
      }
    });

    test("still passes the build's own verification", () => {
      assert.deepEqual(verifyDist(dist), []);
    });

    test("has the manifest that scripts/manifest.mjs describes, as 2-space JSON", () => {
      const raw = read("manifest.json");
      const manifest = JSON.parse(raw);
      assert.deepEqual(
        manifest,
        JSON.parse(JSON.stringify(buildManifest(target, buildInfo.version))),
      );
      assert.equal(raw, `${JSON.stringify(manifest, null, 2)}\n`);
    });

    test("has no forbidden construct in its own JavaScript", () => {
      assert.ok(ownScripts.length >= 10);
      for (const file of ownScripts) {
        const text = read(file);
        for (const needle of FORBIDDEN) {
          assert.equal(found(text, needle), false, `${file} contains ${needle}`);
        }
      }
    });

    // Module service workers reject both, at registration, with an error
    // that only shows on the extensions page. wasm_exec.js is part of the
    // graph. The await test only sees statements at column 0; the browser
    // tests are what proves the worker starts.
    test("has no dynamic import or top-level await in the background's import graph", () => {
      const graph = new Set(["background.js"]);
      for (const file of graph) {
        for (const specifier of importSpecifiers(read(file))) {
          graph.add(path.posix.join(path.posix.dirname(file), specifier));
        }
      }
      assert.ok(graph.has(SHIM), "the background no longer reaches the WASM shim");
      for (const file of graph) {
        const text = read(file);
        assert.doesNotMatch(text, /\bimport\s*\(\s*[^)\s]/, `${file}: dynamic import`);
        assert.doesNotMatch(
          text,
          /^(?:(?:const|let|var)\s[^=\n]*=\s*)?await\b|^for\s+await\b/m,
          `${file}: top-level await`,
        );
      }
    });

    test("has a popup page without inline code, inline style or remote content", () => {
      const html = read("popup/popup.html");
      const scripts = [...html.matchAll(/<script\b([^>]*)>([^]*?)<\/script\s*>/gi)];
      assert.equal(scripts.length, (html.match(/<script\b/gi) ?? []).length);
      assert.ok(scripts.length >= 1);
      for (const [, attributes, body] of scripts) {
        assert.match(attributes, /\ssrc\s*=/, "every script is a file");
        // Without it the browser runs popup.js as a classic script and
        // stops at the first import.
        assert.match(attributes, /\stype\s*=\s*["']?module\b/, "every script is a module");
        assert.equal(body.trim(), "", "inline script");
      }
      assert.doesNotMatch(html, /<style\b/i, "<style> block");
      assert.doesNotMatch(html, /\sstyle\s*=/i, "style attribute");
      assert.doesNotMatch(html, /\son[a-z]+\s*=/i, "inline event handler");
      assert.doesNotMatch(html, /\b[a-z][a-z0-9+.-]*:\/\/|["'=(]\s*\/\//i, "remote URL");
      assert.doesNotMatch(html, /javascript:/i);
    });

    // style-src and img-src are 'self': anything else is dropped silently.
    test("has a stylesheet that loads nothing from elsewhere", () => {
      const css = read("popup/popup.css");
      assert.doesNotMatch(css, /@import/i);
      assert.doesNotMatch(css, /url\(\s*["']?\s*(?:[a-z][a-z0-9+.-]*:|\/\/)/i);
    });

    test("has icons whose pixel size matches their file name", () => {
      const icons = files.filter((file) => file.startsWith("icons/"));
      assert.equal(icons.length, 5);
      for (const file of icons) {
        const size = Number(/icon-(\d+)\.png$/.exec(file)[1]);
        assert.deepEqual(pngSize(path.join(dist, file)), { width: size, height: size }, file);
      }
    });

    test("has the WASM core and shim that build-info.json describes", () => {
      const wasm = readFileSync(path.join(dist, "wasm/keygen.wasm"));
      assert.equal(wasm.subarray(0, 4).toString("latin1"), "\0asm");
      assert.equal(sha256(wasm), buildInfo.sha256["keygen.wasm"]);
      assert.equal(sha256(readFileSync(path.join(dist, SHIM))), buildInfo.sha256["wasm_exec.js"]);
      assert.ok(["tinygo", "go"].includes(buildInfo.compiler));
    });

    // Runs the shipped pair for real. The core reports this identity in
    // every result; the build stamps it at link time.
    test("has a WASM core that starts with its shim and reports the extension's identity", () => {
      const probe = spawnSync(
        process.execPath,
        [fromRoot("scripts", "probe-wasm.mjs"), path.join(dist, "wasm")],
        { encoding: "utf8", timeout: 60_000 },
      );
      assert.equal(probe.status, 0, probe.stderr);
      const core = JSON.parse(probe.stdout);
      assert.equal(core.version, `secretgenerator-extension@${buildInfo.version}`);
      assert.equal(core.sampleLength, 20);
      assert.ok(core.charsets > 0);
    });

    // A checkout with CRLF line endings would otherwise build a package
    // with different checksums from the same commit.
    test("has LF line endings in every text file", () => {
      for (const file of files.filter((name) => /\.(js|json|html|css)$/.test(name))) {
        assert.equal(read(file).includes("\r"), false, file);
      }
    });
  });
}

test("the targets differ only in manifest.json", () => {
  const [chrome, firefox] = TARGETS.map((target) => fromRoot("dist", target));
  assert.deepEqual(walkFiles(chrome), walkFiles(firefox));
  for (const file of walkFiles(chrome)) {
    if (file === "manifest.json") continue;
    assert.ok(
      readFileSync(path.join(chrome, file)).equals(readFileSync(path.join(firefox, file))),
      file,
    );
  }
});
