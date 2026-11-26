import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CSP, TARGETS, buildManifest, parseVersion } from "../../scripts/manifest.mjs";

// Written out again instead of imported: a test that compares the constant
// with itself would accept any policy.
const EXPECTED_CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";

const COMMON_KEYS = [
  "action",
  "background",
  "commands",
  "content_security_policy",
  "default_locale",
  "description",
  "icons",
  "manifest_version",
  "name",
  "permissions",
  "version",
];

test("there are exactly two targets", () => {
  assert.deepEqual([...TARGETS], ["chrome", "firefox"]);
  assert.throws(() => buildManifest("safari", "2.1.0"), /unknown target/);
});

for (const target of TARGETS) {
  describe(`manifest for ${target}`, () => {
    const manifest = buildManifest(target, "2.1.0");

    test("is Manifest V3 with localized name, description and title", () => {
      assert.equal(manifest.manifest_version, 3);
      assert.equal(manifest.name, "__MSG_extName__");
      assert.equal(manifest.description, "__MSG_extDescription__");
      assert.equal(manifest.default_locale, "en");
      assert.equal(manifest.version, "2.1.0");
    });

    test("requests exactly activeTab, contextMenus, scripting and storage", () => {
      assert.deepEqual(manifest.permissions, ["activeTab", "contextMenus", "scripting", "storage"]);
    });

    // Each of these would let pages reach the extension or the extension
    // reach pages without a user gesture.
    test("has no host access, content scripts or page-reachable surface", () => {
      for (const key of [
        "host_permissions",
        "optional_host_permissions",
        "optional_permissions",
        "content_scripts",
        "web_accessible_resources",
        "externally_connectable",
      ]) {
        assert.equal(key in manifest, false, key);
      }
    });

    test("carries the exact content security policy", () => {
      assert.equal(CSP, EXPECTED_CSP);
      assert.deepEqual(manifest.content_security_policy, { extension_pages: EXPECTED_CSP });
    });

    test("declares the fill command and stays within four suggested keys", () => {
      assert.deepEqual(manifest.commands, {
        "fill-password": {
          suggested_key: { default: "Alt+Shift+G", mac: "MacCtrl+Shift+G" },
          description: "__MSG_commandFillPassword__",
        },
      });
      // A fifth suggested key makes the whole manifest invalid in Chrome.
      const suggested = Object.values(manifest.commands).filter((c) => c.suggested_key);
      assert.ok(suggested.length <= 4);
    });

    test("lists the icons and the popup", () => {
      assert.deepEqual(manifest.icons, {
        16: "icons/icon-16.png",
        32: "icons/icon-32.png",
        48: "icons/icon-48.png",
        96: "icons/icon-96.png",
        128: "icons/icon-128.png",
      });
      assert.deepEqual(manifest.action, {
        default_popup: "popup/popup.html",
        default_title: "__MSG_actionTitle__",
        default_icon: { 16: "icons/icon-16.png", 32: "icons/icon-32.png" },
      });
    });

    test("is plain JSON and built fresh on every call", () => {
      assert.deepEqual(JSON.parse(JSON.stringify(manifest)), manifest);
      const other = buildManifest(target, "2.1.0");
      other.permissions.push("tabs");
      assert.deepEqual(buildManifest(target, "2.1.0"), manifest);
    });
  });
}

describe("chrome manifest", () => {
  const manifest = buildManifest("chrome", "2.1.0");

  test("has no keys beyond the expected ones", () => {
    assert.deepEqual(
      Object.keys(manifest).sort(),
      [...COMMON_KEYS, "minimum_chrome_version"].sort(),
    );
  });

  test("runs the background as a module service worker", () => {
    assert.deepEqual(manifest.background, { service_worker: "background.js", type: "module" });
    assert.equal("scripts" in manifest.background, false);
    assert.equal("browser_specific_settings" in manifest, false);
  });

  // Chrome ignores anything after the major version here, and 102 is the
  // first release that knows 'wasm-unsafe-eval'.
  test("has a bare-major minimum_chrome_version of at least 102", () => {
    assert.match(manifest.minimum_chrome_version, /^[1-9][0-9]*$/);
    assert.ok(Number(manifest.minimum_chrome_version) >= 102);
  });
});

describe("firefox manifest", () => {
  const manifest = buildManifest("firefox", "2.1.0");

  test("has no keys beyond the expected ones", () => {
    assert.deepEqual(
      Object.keys(manifest).sort(),
      [...COMMON_KEYS, "browser_specific_settings"].sort(),
    );
  });

  test("runs the background as a module event page", () => {
    assert.deepEqual(manifest.background, { scripts: ["background.js"], type: "module" });
    assert.equal("service_worker" in manifest.background, false);
    assert.equal("minimum_chrome_version" in manifest, false);
  });

  test("declares the add-on id, minimum version and no data collection", () => {
    const settings = manifest.browser_specific_settings;
    assert.deepEqual(Object.keys(settings), ["gecko"]);
    assert.equal("gecko_android" in settings, false);
    assert.equal(settings.gecko.id, "extension@secretgenerator.org");
    assert.equal(settings.gecko.strict_min_version, "142.0");
    assert.deepEqual(settings.gecko.data_collection_permissions.required, ["none"]);
    // Only the copy inside gecko counts.
    assert.equal("data_collection_permissions" in manifest, false);
  });
});

describe("version", () => {
  test("accepts X.Y.Z", () => {
    assert.deepEqual(parseVersion("2.1.0"), { manifest: "2.1.0", full: "2.1.0", prerelease: null });
    assert.equal(parseVersion("0.0.1").manifest, "0.0.1");
    assert.equal(parseVersion("65535.65535.65535").manifest, "65535.65535.65535");
  });

  test("keeps a prerelease out of the manifest version", () => {
    assert.deepEqual(parseVersion("2.2.0-alpha.3"), {
      manifest: "2.2.0",
      full: "2.2.0-alpha.3",
      prerelease: "alpha.3",
    });
    assert.equal(parseVersion("2.2.0-rc.1").prerelease, "rc.1");
  });

  test("rejects everything a browser or store would reject", () => {
    for (const bad of [
      "",
      "2",
      "2.1",
      "2.1.0.4",
      "v2.1.0",
      "2.01.0",
      "02.1.0",
      "2.1.0-",
      "2.1.0-alpha..1",
      "2.1.0+build.5",
      "2.1.0 ",
      " 2.1.0",
      "2.1.x",
      "-1.0.0",
      "65536.0.0",
      "1.0.99999",
      "0.0.0",
      "0.0.0-alpha.1",
      undefined,
      null,
      210,
    ]) {
      assert.throws(() => parseVersion(bad), /invalid version/, String(bad));
    }
  });

  test("a release has the same version in both manifests and no version_name", () => {
    for (const target of TARGETS) {
      const manifest = buildManifest(target, "3.4.5");
      assert.equal(manifest.version, "3.4.5");
      assert.equal("version_name" in manifest, false);
    }
  });

  // Chrome shows version_name to the user. Firefox has no such key, and
  // its linter would have nothing to say about it either way.
  test("a prerelease gets version_name in the Chrome manifest only", () => {
    const chrome = buildManifest("chrome", "2.2.0-alpha.3");
    assert.equal(chrome.version, "2.2.0");
    assert.equal(chrome.version_name, "2.2.0-alpha.3");
    const firefox = buildManifest("firefox", "2.2.0-alpha.3");
    assert.equal(firefox.version, "2.2.0");
    assert.equal("version_name" in firefox, false);
  });

  test("an invalid version fails the manifest too", () => {
    assert.throws(() => buildManifest("chrome", "2.1"), /invalid version/);
  });
});
