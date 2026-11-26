// The build the other end-to-end tests load, as it lies on disk: what its
// manifest asks for, and that nothing made for testing went into it.
//
// test/unit/dist.test.mjs checks the content of dist/ file by file. This
// file is about the two things the end-to-end tests could hide: the
// fallback mode of helpers.mjs loads a copy with host permissions, and the
// tests reach into the pages with helpers of their own.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { buildManifest } from "../../scripts/manifest.mjs";
import { FALLBACK_HOST_PERMISSIONS, SHIPPED_DIR, shippedManifest } from "./helpers.mjs";

function shippedFiles(dir = SHIPPED_DIR, prefix = "") {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? shippedFiles(path.join(dir, entry.name), `${prefix}${entry.name}/`)
      : [`${prefix}${entry.name}`],
  );
}

describe("the shipped Chrome build", () => {
  test("its manifest asks for no host permissions", () => {
    const manifest = shippedManifest();
    for (const key of [
      "host_permissions",
      "optional_host_permissions",
      "optional_permissions",
      "content_scripts",
      "externally_connectable",
      "web_accessible_resources",
    ]) {
      assert.equal(manifest[key], undefined, `manifest.${key}`);
    }
    assert.deepEqual(manifest.permissions, ["activeTab", "contextMenus", "scripting", "storage"]);
    // In Manifest V2 a match pattern among the permissions was a host
    // permission. Chrome ignores it in V3, but it has no business there.
    for (const permission of manifest.permissions) {
      assert.doesNotMatch(permission, /[:/*<]/, `"${permission}" looks like a match pattern`);
    }
    for (const pattern of FALLBACK_HOST_PERMISSIONS) {
      assert.equal(JSON.stringify(manifest).includes(pattern), false, pattern);
    }
  });

  test("its manifest is exactly what the build script writes", () => {
    const manifest = shippedManifest();
    // No "key" (it would pin the extension id, which only a test needs),
    // no "update_url", nothing a build step for tests could have added.
    assert.deepEqual(manifest, buildManifest("chrome", manifest.version_name ?? manifest.version));
  });

  test("there are no test hooks in it", () => {
    const files = shippedFiles();
    assert.ok(files.includes("background.js") && files.includes("popup/popup.js"), "the build");
    assert.deepEqual(
      files.filter((file) =>
        /(^|[/._-])(tests?|spec|fixtures?|mocks?|e2e|debug)([/._-]|$)/i.test(file),
      ),
      [],
      "files named like test material",
    );

    // What the tests of this directory, or a build made for them, would
    // leave behind. The WASM shim is the toolchain's file and is skipped.
    const hooks = [
      "__cspViolations",
      "__storageChanges",
      "fixtureEvents",
      "playwright",
      "E2E_",
      "data-test",
      "debugger",
      "sourceMappingURL",
      "host_permissions",
      "127.0.0.1",
      "localhost",
      ".test/",
    ];
    const text = files.filter(
      (file) => /\.(js|html|css|json)$/.test(file) && file !== "wasm/wasm_exec.js",
    );
    const queryReaders = [];
    for (const file of text) {
      const content = readFileSync(path.join(SHIPPED_DIR, file), "utf8");
      for (const hook of hooks) {
        assert.equal(content.includes(hook), false, `${file} contains "${hook}"`);
      }
      if (/location\.(search|hash|href)|URLSearchParams/.test(content)) queryReaders.push(file);
    }

    // One hook is specified and ships: popup.html?tabId=<n> names the tab
    // that Fill writes to, which is how these tests point a popup that is
    // open in a tab at a page. Nothing else may read the URL.
    assert.deepEqual(queryReaders, ["popup/popup.js"]);
    const popup = readFileSync(path.join(SHIPPED_DIR, "popup/popup.js"), "utf8");
    assert.deepEqual(
      popup.match(/searchParams|URLSearchParams\([^)]*\)\s*\.get\(\s*"[^"]*"\s*\)|location\.\w+/g),
      ['URLSearchParams(location.search).get("tabId")'],
    );
  });
});
