// The extension manifest for each build target. Pure (no file access, no
// clock) so the unit tests can check every key without running a build.

/** `chrome` also serves Edge. */
export const TARGETS = Object.freeze(["chrome", "firefox"]);

/**
 * Tested in Chromium: the WASM core instantiates only with
 * 'wasm-unsafe-eval'. Everything that is not listed falls back to
 * default-src 'none'; connect-src 'self' is what lets the popup and the
 * background fetch the packaged keygen.wasm while every request to a
 * network host stays blocked.
 */
export const CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";

/** Sorted. Deliberately no host permissions: fills run under activeTab. */
export const PERMISSIONS = Object.freeze(["activeTab", "contextMenus", "scripting", "storage"]);

export const ICON_SIZES = Object.freeze([16, 32, 48, 96, 128]);

/** Becomes permanent on addons.mozilla.org with the first submission. */
export const GECKO_ID = "extension@secretgenerator.org";

// X.Y.Z, optionally followed by a semver prerelease such as -alpha.3 (the
// form of the repository's hand-pushed prerelease tags). No leading zeros:
// both stores reject them.
const VERSION =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/**
 * Splits a package version into what a manifest can carry. Browsers accept
 * only dot-separated integers in `version`, so a prerelease suffix cannot
 * go there. Prereleases of one release therefore share a manifest version:
 * they are for testing, not for the stores, which want the version to
 * increase with every upload.
 *
 * @param {string} version `X.Y.Z` or `X.Y.Z-pre.N`
 * @returns {{ manifest: string, full: string, prerelease: string | null }}
 */
export function parseVersion(version) {
  const match = typeof version === "string" ? VERSION.exec(version) : null;
  if (!match) {
    throw new Error(
      `invalid version ${JSON.stringify(version)}: expected X.Y.Z or X.Y.Z-pre.N (no "v" prefix)`,
    );
  }
  const parts = match.slice(1, 4).map(Number);
  if (parts.some((part) => part > 65535)) {
    throw new Error(`invalid version "${version}": each part must be at most 65535`);
  }
  if (parts.every((part) => part === 0)) {
    throw new Error(`invalid version "${version}": the parts must not all be zero`);
  }
  return { manifest: parts.join("."), full: version, prerelease: match[4] ?? null };
}

const icon = (size) => `icons/icon-${size}.png`;
const icons = (sizes) => Object.fromEntries(sizes.map((size) => [String(size), icon(size)]));

/**
 * @param {"chrome" | "firefox"} target
 * @param {string} version `X.Y.Z` or `X.Y.Z-pre.N`
 * @returns {Record<string, unknown>} the manifest.json content
 */
export function buildManifest(target, version) {
  if (!TARGETS.includes(target)) {
    throw new Error(`unknown target "${target}" (expected chrome or firefox)`);
  }
  const parsed = parseVersion(version);
  const chrome = target === "chrome";

  return {
    manifest_version: 3,
    name: "__MSG_extName__",
    description: "__MSG_extDescription__",
    version: parsed.manifest,
    // Display only. The Firefox manifest goes without it: Firefox has no
    // use for the key.
    ...(chrome && parsed.prerelease ? { version_name: parsed.full } : {}),
    default_locale: "en",
    icons: icons(ICON_SIZES),
    action: {
      default_popup: "popup/popup.html",
      default_title: "__MSG_actionTitle__",
      default_icon: icons([16, 32]),
    },
    // One file for both browsers: a service worker in Chrome, an event
    // page in Firefox. A service_worker key in the Firefox manifest is a
    // lint error on addons.mozilla.org.
    background: chrome
      ? { service_worker: "background.js", type: "module" }
      : { scripts: ["background.js"], type: "module" },
    permissions: [...PERMISSIONS],
    content_security_policy: { extension_pages: CSP },
    commands: {
      // The command name is also hard-coded in src/background.ts and in
      // the popup. At most four commands may carry a suggested key.
      "fill-password": {
        suggested_key: { default: "Alt+Shift+G", mac: "MacCtrl+Shift+G" },
        description: "__MSG_commandFillPassword__",
      },
    },
    ...(chrome
      ? { minimum_chrome_version: "123" }
      : {
          browser_specific_settings: {
            gecko: {
              id: GECKO_ID,
              // With 140 the AMO linter warns about Firefox for Android,
              // which this extension does not support. 142.0 lints clean
              // without a gecko_android entry.
              strict_min_version: "142.0",
              // Has to sit inside gecko; at the top level it is ignored.
              data_collection_permissions: { required: ["none"] },
            },
          },
        }),
  };
}
