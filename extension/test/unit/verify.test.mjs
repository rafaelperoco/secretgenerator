// The checks that scripts/build.mjs runs on dist/<target>/, fed with small
// broken builds to show that each one actually fails.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import {
  checkImports,
  checkLocales,
  checkManifestFiles,
  checkPageReferences,
  checkWasm,
  importSpecifiers,
  verifyDist,
} from "../../scripts/verify.mjs";
import { fromRoot } from "./helpers.mjs";

const scratch = mkdtempSync(path.join(os.tmpdir(), "secretgenerator-verify-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
/** Writes a directory tree from a { "relative/path": content } map. */
function tree(files) {
  const dir = path.join(scratch, String(counter++));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), content);
  }
  return dir;
}

describe("importSpecifiers", () => {
  test("finds static imports, re-exports and literal dynamic imports", () => {
    const source = [
      'import "../wasm/wasm_exec.js";',
      'import { a } from "./a.js";',
      "import b, { c as d } from './b.js';",
      'import * as ns from "./ns.js";',
      "import {",
      "  e,",
      "  f,",
      '} from "./multi.js";',
      'export * from "./star.js";',
      'export { g } from "./named.js";',
      'const lazy = await import("./lazy.js");',
    ].join("\n");
    assert.deepEqual(importSpecifiers(source).sort(), [
      "../wasm/wasm_exec.js",
      "./a.js",
      "./b.js",
      "./lazy.js",
      "./multi.js",
      "./named.js",
      "./ns.js",
      "./star.js",
    ]);
  });

  test("ignores prose, plain exports and identifiers that contain the word", () => {
    const source = [
      "// wasm_exec.js is imported statically because module service workers forbid",
      "// dynamic import(). It only installs a `Go` constructor on globalThis.",
      'export const from = "./not-a-module.js";',
      'export function load() { return "./also-not.js"; }',
      "const importObject = { gojs: {} };",
      "    const text = \"import x from './quoted.js'\";",
      "go.importObject.gojs = {};",
    ].join("\n");
    assert.deepEqual(importSpecifiers(source), []);
  });
});

describe("checkImports", () => {
  test("accepts relative specifiers that name an existing .js file", () => {
    const dir = tree({
      "background.js": 'import { x } from "./lib/x.js";\n',
      "lib/x.js": 'import "../wasm/shim.js";\nexport const x = 1;\n',
      "wasm/shim.js": "globalThis.Go = class {};\n",
      "popup/popup.js": 'import { x } from "/lib/x.js";\n',
    });
    assert.deepEqual(checkImports(dir), []);
  });

  test("reports each kind of specifier a browser cannot load", () => {
    const dir = tree({
      "a.js": [
        'import { x } from "./lib/x";',
        'import { y } from "./lib/missing.js";',
        'import z from "lodash";',
        'import w from "https://example.com/w.js";',
        'import v from "../outside.js";',
        "",
      ].join("\n"),
      "lib/x.js": "export const x = 1;\n",
    });
    const problems = checkImports(dir);
    assert.equal(problems.length, 5, problems.join("\n"));
    assert.match(problems[0], /"\.\/lib\/x" must end in \.js/);
    assert.match(problems[1], /"\.\/lib\/missing\.js" does not resolve/);
    assert.match(problems[2], /"lodash" is not a relative path/);
    assert.match(problems[3], /"https:\/\/example\.com\/w\.js" is not a relative path/);
    assert.match(problems[4], /"\.\.\/outside\.js" points outside/);
  });
});

describe("the other dist checks", () => {
  const manifest = {
    default_locale: "en",
    name: "__MSG_extName__",
    icons: { 16: "icons/icon-16.png" },
    action: { default_popup: "popup/popup.html", default_icon: { 16: "icons/icon-16.png" } },
    background: { service_worker: "background.js" },
  };
  const good = {
    "manifest.json": JSON.stringify(manifest),
    "background.js": "",
    "icons/icon-16.png": "png",
    "popup/popup.html":
      '<link rel="stylesheet" href="popup.css"><img src="../icons/icon-16.png"><script type="module" src="popup.js"></script><a href="#top">top</a>',
    "popup/popup.css": "",
    "popup/popup.js": "",
    "wasm/keygen.wasm": Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]),
    "wasm/wasm_exec.js": "globalThis.Go = class {};\n",
    "_locales/en/messages.json": '{"extName":{"message":"x"},"other":{"message":"y"}}',
    "_locales/pt_BR/messages.json": '{"extName":{"message":"x"},"other":{"message":"z"}}',
  };

  test("pass on a complete build", () => {
    assert.deepEqual(verifyDist(tree(good)), []);
  });

  test("report a file the manifest refers to but the build lacks", () => {
    const { "icons/icon-16.png": _icon, "background.js": _background, ...rest } = good;
    const problems = checkManifestFiles(tree(rest), manifest);
    assert.equal(problems.length, 2, problems.join("\n"));
    assert.match(problems.join("\n"), /"icons\/icon-16\.png"/);
    assert.match(problems.join("\n"), /"background\.js"/);
    assert.match(
      checkManifestFiles(tree(good), { ...manifest, background: { scripts: ["bg.js"] } }).join(
        "\n",
      ),
      /"bg\.js"/,
    );
  });

  test("report a script or stylesheet the popup page loads but the build lacks", () => {
    const { "popup/popup.js": _script, ...rest } = good;
    assert.match(checkPageReferences(tree(rest), manifest).join("\n"), /refers to "popup\.js"/);
  });

  test("report a missing, empty or mismatched WASM core", () => {
    const { "wasm/keygen.wasm": _wasm, ...rest } = good;
    assert.match(checkWasm(tree(rest)).join("\n"), /wasm\/keygen\.wasm is missing/);
    assert.match(
      checkWasm(tree({ ...good, "wasm/wasm_exec.js": "" })).join("\n"),
      /wasm\/wasm_exec\.js is empty/,
    );
    assert.match(
      checkWasm(tree({ ...good, "wasm/keygen.wasm": "<html>404</html>" })).join("\n"),
      /not a WebAssembly module/,
    );
  });

  test("report locale files that do not parse or disagree about the keys", () => {
    const broken = tree({ ...good, "_locales/pt_BR/messages.json": "{" });
    assert.match(checkLocales(broken, manifest).join("\n"), /_locales\/pt_BR\/messages\.json: /);

    const uneven = tree({
      ...good,
      "_locales/pt_BR/messages.json": '{"extName":{"message":"x"},"extra":{"message":"z"}}',
    });
    const problems = checkLocales(uneven, manifest).join("\n");
    assert.match(problems, /_locales\/pt_BR: missing "other"/);
    assert.match(problems, /_locales\/pt_BR: "extra" is not in _locales\/en/);

    const untexted = tree({
      ...good,
      "_locales/en/messages.json": '{"extName":{},"other":{"message":"y"}}',
    });
    assert.match(checkLocales(untexted, manifest).join("\n"), /"extName" has no message/);
  });

  // Chrome refuses the whole extension when the name does not resolve.
  test("report a __MSG_ reference without a message", () => {
    const problems = checkLocales(tree(good), {
      ...manifest,
      description: "__MSG_extDescription__",
    });
    assert.match(problems.join("\n"), /__MSG_extDescription__/);
  });

  test("report an unreadable manifest", () => {
    assert.match(verifyDist(tree({ "manifest.json": "{" })).join("\n"), /^manifest\.json: /);
    assert.match(verifyDist(tree({ "other.txt": "" })).join("\n"), /^manifest\.json: /);
  });
});

// The scripts locate the extension from their own path, so a copy of
// scripts/ in an otherwise empty directory behaves like a checkout without
// sources.
describe("build.mjs command line", () => {
  const root = path.join(scratch, "cli");
  cpSync(fromRoot("scripts"), path.join(root, "scripts"), { recursive: true });
  writeFileSync(path.join(root, "package.json"), '{"version":"2.1.0"}\n');
  const build = (...args) =>
    spawnSync(process.execPath, [path.join(root, "scripts", "build.mjs"), ...args], {
      encoding: "utf8",
    });

  test("names the entry files that are missing", () => {
    const all = build();
    assert.equal(all.status, 1);
    assert.match(
      all.stderr,
      /missing entry files: src\/background\.ts, src\/popup\/popup\.ts, static\/popup\/popup\.html, static\/popup\/popup\.css/,
    );

    for (const file of [
      "src/popup/popup.ts",
      "static/popup/popup.html",
      "static/popup/popup.css",
    ]) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), "");
    }
    const one = build();
    assert.equal(one.status, 1);
    assert.match(one.stderr, /missing entry file: src\/background\.ts\n/);
  });

  test("rejects options it does not know", () => {
    for (const [args, message] of [
      [["--target", "safari"], /unknown target "safari"/],
      [["--compiler", "gccgo"], /unknown compiler "gccgo"/],
      [["--version", "v2.1.0"], /invalid version "v2\.1\.0"/],
      [["--version", "2.1"], /invalid version "2\.1"/],
      [["--minify"], /Unknown option '--minify'/],
    ]) {
      const result = build(...args);
      assert.equal(result.status, 1, args.join(" "));
      assert.match(result.stderr, message, args.join(" "));
      assert.equal(result.stdout, "", args.join(" "));
    }
  });

  test("prints its usage", () => {
    const result = build("--help");
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^usage: node scripts\/build\.mjs/);
  });
});
