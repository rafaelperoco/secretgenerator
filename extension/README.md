# secretgenerator browser extension

A Manifest V3 extension for Chrome, Edge and Firefox. It runs the
secretgenerator core, compiled to WebAssembly, inside the browser. The popup
generates passwords, passphrases, secrets, API keys and PINs, and a generated
password can be written into the field that has focus on the page.

There is one codebase and two build targets: `chrome` (Chrome and Edge) and
`firefox`.

The extension is not published in any extension store. For now it is built
from source and loaded as an unpacked extension. See
[Build from source](#build-from-source) and
[Load the unpacked extension](#load-the-unpacked-extension).

## Features

- Six tabs: Password, Passphrase, Secret, API key, PIN and Check. The first
  five generate a value with the options of the matching CLI subcommand (see
  [docs/SUBCOMMANDS.md](../docs/SUBCOMMANDS.md)). Check estimates the entropy
  of a password you type.
- Each value is shown with its entropy in bits, its length and the estimated
  time to crack under the five attacker profiles of the core.
- The entropy floors of the core apply. A password below the floor is refused
  unless "Allow below the entropy floor" is ticked, and a PIN is generated
  only after its low entropy has been acknowledged. Errors and warnings from
  the core are shown as the core words them, in English.
- Copy puts the value on the clipboard. Fill in page writes it into the
  focused field. A context-menu item and a keyboard shortcut generate a
  password and fill it without opening the popup.
- The options are saved and restored. Generated values and the password typed
  on the Check tab are never saved.
- The interface follows the light or dark scheme of the browser and is
  available in English and Brazilian Portuguese.

The defaults are those of the CLI, with one difference: a password must
contain a lowercase letter, an uppercase letter and a digit. About 3% of
20-character alphanumeric passwords have no digit, and sign-up forms reject
those. Rejection sampling keeps the output uniform over the strings that meet
the requirement.

All randomness comes from Go's `crypto/rand`. In a browser that reads
`crypto.getRandomValues`.

## Filling a field

There are three ways to fill. Each one writes into the field that has focus
on the page, and each one needs a user action: the extension never touches a
page by itself.

|                             | Popup: Fill in page           | Context menu                              | Keyboard shortcut                         |
| --------------------------- | ----------------------------- | ----------------------------------------- | ----------------------------------------- |
| Value                       | The one shown in the popup    | A new password, Password tab settings     | A new password, Password tab settings     |
| Fields                      | Text and password fields      | Text and password fields                  | Password fields only                      |
| Value longer than the field | Refused, with the limit shown | Retried once at exactly the field's limit | Retried once at exactly the field's limit |

### Popup

Click into the field, open the popup and press **Fill in page**. The value on
display is written into the field that has focus in that tab. Any generator
tab works, not only Password.

The button is disabled while there is no value, and on pages that the browser
keeps extensions out of (see [Known limitations](#known-limitations)).

### Context menu

Right-click an editable field and choose **Generate password and fill**. A
new password is generated with the saved settings of the Password tab and
written into the focused field of the frame that was clicked. The item is
offered on `http`, `https` and `file` pages. It is not offered inside
`about:blank` and `srcdoc` frames.

### Keyboard shortcut

`Alt+Shift+G`, or `Control+Shift+G` on macOS. It does the same as the context
menu, with one restriction: it only fills `<input type="password">`. The
shortcut acts without showing what it will write to. If a page moved the
focus, a new password must not end up readable in a text field.

A suggested key that is already taken by the browser or by another extension
is left unassigned, without any message. The popup footer then says "not
set". Assign a key at `chrome://extensions/shortcuts`
(`edge://extensions/shortcuts` in Edge), or in Firefox at `about:addons`, gear
menu, Manage Extension Shortcuts.

A key that is held down repeats, and the browser delivers every repeat as a
new command. A command within one second of the previous one for the same
tab is ignored, so a held key fills once.

### Rules for all three

- **Fields.** `<input>` of type `password`, `text`, `search`, `tel`, `url` or
  `email`, and `<textarea>`. An `<input type="number">` is filled only with a
  value made of digits, such as a PIN. Disabled, read-only and invisible
  fields are not filled.
- **Focus.** The popup and the shortcut start at the top document and follow
  the focus into same-origin iframes and open shadow roots. The context menu
  starts in the frame that was clicked.
- **Confirmation field.** When the filled field is a password field inside a
  `<form>` and is not marked `autocomplete="current-password"`, the next
  password field of the same form is filled with the same value, provided it
  is enabled, visible, long enough for the value and not marked
  `current-password` or `one-time-code`, and provided it is empty or still
  holds what the focused field held before the fill. A second fill
  therefore replaces both fields, while a confirmation field with other
  content is left alone. Outside a `<form>` only the focused field is
  filled: there is no safe way to tell a confirmation field from an
  unrelated one.
- **`maxlength`.** A value longer than the field's `maxlength` is never
  written. The browser does not cut a value set by script to `maxlength`, so
  the field would hold the full value while the site truncates or rejects
  it. The popup refuses the fill and shows the limit; generate a shorter
  value and fill again. The context menu and the shortcut retry once with a
  password of exactly `maxlength` characters and otherwise unchanged
  settings. If the core refuses that length, nothing is filled and the
  message names the limit. With the default settings the core refuses fewer
  than 14 characters.
- **Events.** The value is set through the element's native setter, followed
  by `input` and `change` events, so that pages which bind their fields
  through a framework register it. This was tested with React 18 and Vue 3.
  The field is then read back. If the page changed or rejected the value,
  the fill is reported as "Filled, but the page changed the value".
- **Plain HTTP.** When the popup fills a field on a page that is not served
  over HTTPS, it adds a warning to the result. The context menu and the
  shortcut give no such warning.

### Feedback from the context menu and the shortcut

Neither has an interface of its own. The result is shown on the toolbar
button for four seconds: a green `OK` or a red `!` badge, with the message as
the tooltip. Browsers keep the toolbar button in the extensions menu until it
is pinned, and the badge is not visible there.

When a fill fails, or the page changed the value, the message is also kept
for the popup, which shows it the next time it is opened within one minute.
After a failure the extension also asks the browser to open the popup. Chrome
and Edge do that from version 127; a browser that refuses leaves the badge
and the stored message.

### What the extension does not do

It generates values. It does not save them, and it is not a password manager.
A password filled by the context menu or the shortcut exists only in the
page: if the form is lost before you saved the password somewhere, the
password is lost with it.

## Permissions

| Permission     | Why it is needed                                                                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `activeTab`    | Temporary access to the current tab, given by the browser only after the user opens the popup, clicks the context-menu item or presses the shortcut. It takes the place of host permissions.      |
| `scripting`    | `scripting.executeScript` injects the fill function into the tab under that temporary access.                                                                                                     |
| `contextMenus` | The one context-menu item.                                                                                                                                                                        |
| `storage`      | Saves the generator options (`storage.local`, key `settings.v1`) and one pending fill message for the popup (`storage.session`, key `notice.v1`, memory only). Generated values are never stored. |

Not requested: host permissions, `tabs`, `clipboardWrite` and `clipboardRead`.
Copy works without a permission because it runs in the click handler of the
button. The manifest has no content scripts, no `web_accessible_resources`
and no `externally_connectable`, and the code registers no message
listeners, so a web page has no way to address the extension.

## Security notes

- **It runs locally.** The extension makes no network requests, and its
  content security policy would block them:

  ```
  default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'
  ```

  `connect-src 'self'` lets the extension pages load the packaged
  `keygen.wasm` and nothing from a network host. `'wasm-unsafe-eval'` is
  required to instantiate WebAssembly and does not allow `eval`. There is no
  remote code and no telemetry. The Firefox manifest declares that no data
  is collected (`data_collection_permissions: none`).

- **No content scripts.** Nothing from the extension runs in a page until
  the user asks for a fill. Then one self-contained function is injected
  into the tab, in the extension's isolated world, where page scripts cannot
  call or change it. It does not return or log the value it was given.
- **The page can read what is filled into it.** Once a value is in a field,
  every script of that page can read it, third-party scripts included,
  exactly as with a typed password. Look at where you are before you fill.
- **Values are never written to storage.** A generated value exists in local
  variables, in the popup while it is open, and in the field it was filled
  into. It is not put into extension storage, logs, the URL, the badge, the
  tooltip or the stored fill message.
- **WASM memory is not wiped.** The core does not zero its memory. A
  generated value stays in the memory of the WASM instance until that
  instance goes away: when the popup closes, or, for the context menu and
  the shortcut, when the browser stops the idle background context.
- **Copy leaves the value on the clipboard.** The extension does not clear
  it. Clipboard history and clipboard sync of the operating system may keep
  it for longer.
- **Firefox embeds the value in the injected script.** Firefox runs an
  injected function by building its call as script text, arguments
  included. For the duration of the call the value exists as source text in
  the extension process and in the page's content process. It is held in
  memory only.
- **The Check tab.** The password typed there is passed to the core inside
  the popup. It is not saved and it is gone when the popup closes.
- **Saved options are not secret.** They include the prefix, separator and
  excluded characters typed into the option fields. Do not type secrets
  there.

Report vulnerabilities as described in [SECURITY.md](../SECURITY.md).

## Known limitations

- **Cross-origin and sandboxed iframes.** `activeTab` covers the top-level
  page and its same-origin frames only. A field inside a frame from another
  site, such as an embedded payment or login form, cannot be filled. The
  message says so; use Copy and paste.
- **Closed shadow roots.** Focus cannot be followed into them.
- **Rich-text editors.** `contenteditable` elements are not filled.
- **Restricted pages.** Browser pages (`chrome://`, `edge://`, `about:`),
  the extension stores, the built-in PDF viewer and pages of other
  extensions cannot be filled. In Chrome, `file://` pages can be filled only
  after "Allow access to file URLs" is enabled for the extension.
- **Site password rules.** The extension knows `maxlength` and nothing else.
  A site that demands a symbol or forbids one is not detected; adjust the
  Password tab and fill again.
- **Browsers.** Chrome and Edge 123 or later, Firefox 142 or later. There is
  no build for Firefox for Android, which has neither context menus nor
  extension shortcuts, and none for Safari.
- **No clipboard auto-clear.**
- **No history.** A value that was filled by the context menu or the
  shortcut is only in the page.
- **Languages.** English and Brazilian Portuguese. Messages from the core
  are always English.

## Build from source

### Requirements

| Tool    | Version | Used for                                                                                  |
| ------- | ------- | ----------------------------------------------------------------------------------------- |
| Go      | 1.26.9  | The toolchain named in `go.mod`. TinyGo builds on it, and it compiles development builds. |
| TinyGo  | 0.41.1  | Compiles the WASM core of release builds.                                                 |
| Node.js | 22      | Runs `tsc` and the build scripts. 22.12 or later, with npm.                               |

The WASM core is the Go package `web/wasm` of this repository and imports
`internal/` and `pkg/`. A build therefore needs the whole repository, not
only `extension/`.

### Release build

```sh
git clone https://github.com/rafaelperoco/secretgenerator
cd secretgenerator/extension
npm ci
npm run build -- --compiler tinygo
```

This writes the unpacked extension to `dist/chrome/` and `dist/firefox/`. The
build

1. compiles `src/` with `tsc` into ES modules, with no bundler and no
   minifier;
2. compiles `../web/wasm` with
   `tinygo build -target wasm -no-debug` into `keygen.wasm` and copies
   TinyGo's own `wasm_exec.js` next to it;
3. starts that core once in Node.js, with that `wasm_exec.js`, and fails
   unless it generates a password and reports
   `secretgenerator-extension@<version>` as its version;
4. copies `static/` and writes the `manifest.json` of each target;
5. verifies the result: every file the manifest names exists, every import
   resolves, and both locale files have the same keys.

`--compiler tinygo` makes the build fail when TinyGo is missing. Add
`--target chrome` or `--target firefox` to build one target.

The output depends only on the source tree and the toolchain. No timestamp
and nothing from git goes into it.

### Development build without TinyGo

```sh
npm run build
```

Without `--compiler`, the build uses TinyGo when it is on `PATH` and
otherwise falls back to the standard Go toolchain, with a warning.
`npm run build -- --compiler go` asks for standard Go explicitly.

A standard-Go build is a development build. It compiles the same Go sources
(with `go build -trimpath -buildvcs=false`, so nothing from git ends up in
the binary) and behaves the same in the browser, but `keygen.wasm` is about
3 MB instead of about 0.5 MB, and it is paired with Go's own `wasm_exec.js`.
The two `wasm_exec.js` files are not interchangeable. Release packages are
built with TinyGo, and packaging refuses a development build unless it is
told otherwise.

### Packages

```sh
npm run package
```

This zips each `dist/<target>/` into
`artifacts/secretgenerator-extension-<version>-<target>.zip`, with
`manifest.json` at the root of the zip, and writes `artifacts/SHA256SUMS`:

```sh
cd artifacts
sha256sum -c SHA256SUMS
```

The zips are deterministic: the entries are sorted and carry one fixed
timestamp (1 January 1980, or `SOURCE_DATE_EPOCH` when it is set) and fixed
permissions. The same source tree, toolchain and Node.js version give the
same bytes. The Node.js version matters because the compression comes from
its bundled zlib.

`npm run package -- --allow-dev-build` packages a standard-Go build for local
testing. Do not publish such a package.

### Version

`version` in `package.json` is the only source of the manifest version.
release-please bumps it, together with `package-lock.json`, in the release
pull request. `npm run build -- --version X.Y.Z` overrides it; the release
workflow passes the tag that way.

A manifest version can only hold numbers. For a prerelease such as
`2.2.0-alpha.1` the manifest gets `2.2.0`, and the Chrome manifest also
carries the full string as `version_name`.

## Load the unpacked extension

Chrome:

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and select `extension/dist/chrome`.

Edge: the same steps at `edge://extensions`, with the same directory.

Firefox:

1. Open `about:debugging` and choose **This Firefox**.
2. Choose **Load Temporary Add-on** and select
   `extension/dist/firefox/manifest.json`.

Firefox removes a temporary add-on when it restarts. Release versions of
Firefox do not install an unsigned add-on permanently.

After a rebuild, reload the extension on the same page. Pin the toolbar
button to see the badge that the context menu and the shortcut use for
feedback.

## Tests

| Command                                    | What it does                                                                                                                                                                                             |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                        | Type-checks `src/` without writing output.                                                                                                                                                               |
| `npm test`                                 | Builds, then runs the unit tests in `test/unit/`: the manifest of both targets, the locale files, option sanitizing, self-containment of the injected fill function, the contents of `dist/`, packaging. |
| `npm run lint:firefox`                     | Runs `addons-linter`, the linter of addons.mozilla.org, on `dist/firefox`. Warnings fail.                                                                                                                |
| `npm run test:e2e`                         | Runs the Playwright tests in `test/e2e/` against `dist/chrome` in Chromium. Build first.                                                                                                                 |
| `node test/firefox/smoke.mjs dist/firefox` | Installs the Firefox build in headless Firefox through geckodriver and checks that the popup generates a password and a passphrase. Needs Firefox and geckodriver on `PATH`.                             |

The end-to-end tests need the Chromium build that belongs to the pinned
Playwright version:

```sh
npx playwright install chromium
```

They load `dist/chrome` as it is built, without host permissions, and drive
the popup page, the popup's Fill button, the context-menu item and the
shortcut against the fixture pages in `test/e2e/fixtures/`, served from a
local port. Set `EXTENSION_DIR` to test another unpacked Chrome build, for
example an unzipped package.

Every run prints how it got access to the fixture pages, as a line that
starts with `[e2e] page access:`. There are two ways:

- `activeTab`: the way a user gives access. The DevTools command
  `Extensions.triggerAction` stands for a click on the toolbar button, which
  grants `activeTab` for the tab and opens the real popup. The command is
  experimental. If it is refused, the tests try once more with Chromium's
  `--enable-unsafe-extension-debugging` flag.
- `host-permissions`: the fallback for a Chromium that does not have the
  command. The browser loads a temporary copy of the build whose manifest
  lists the fixture hosts. `dist/chrome` itself is never changed, and
  `test/e2e/dist.test.mjs` checks that its manifest asks for no hosts. A run
  in this mode does not show that the extension works with `activeTab` alone.

`E2E_PAGE_ACCESS=activeTab` makes a run fail instead of falling back, and
`E2E_PAGE_ACCESS=host-permissions` goes straight to the fallback.

`test/e2e/action-popup-headed.test.mjs` needs a browser window, because only
there the browser sizes the popup to its content. It is skipped without an X
display. On a machine without a screen, `xvfb-run -a npm run test:e2e` runs
it together with the rest.

`.github/workflows/extension-ci.yml` runs all of the above on every push to
`main` and every pull request that touches the extension or the Go core,
with a TinyGo build, and keeps the zips as a workflow artifact.

What the automated tests do not cover:

- A real click on the context-menu item and a real press of the shortcut.
  Automation cannot perform either, so the end-to-end tests hand these two
  events to the extension directly. They do not show that the menu item
  appears on a field, that the key is bound, or that either gesture grants
  `activeTab`.
- Firefox beyond the linter and the smoke test. The smoke test was written
  where no Firefox was available. Until it has passed in CI, its step in the
  workflow is informational and does not fail the run.
- Edge and macOS.

The checklist below is for these.

## Manual QA checklist

Run it on a release build before publishing a version. A sign-up form with a
password field and a confirmation field inside one `<form>` is needed, on an
`https` page.

Chrome, with `dist/chrome` loaded and the toolbar button pinned:

- [ ] The popup opens and every generator tab shows a value. Copy puts the
      value on the clipboard.
- [ ] Options survive closing the popup and restarting the browser.
- [ ] PIN: nothing is generated until the acknowledgement box is ticked.
- [ ] Check: typing a password shows its entropy, and nothing is left in the
      field after the popup was closed and opened again.
- [ ] Popup fill: focus the password field, open the popup, press **Fill in
      page**. Both fields hold the value on display.
- [ ] Context menu: right-click the password field and choose **Generate
      password and fill**. Both fields are filled and the badge shows `OK`.
- [ ] Shortcut: focus the password field and press `Alt+Shift+G`. Both fields
      are filled with one new value.
- [ ] Shortcut held down for two seconds: both fields still hold the same
      value.
- [ ] Shortcut in a text field: nothing is filled, the badge shows `!`, and
      the popup opens with the reason.
- [ ] A field with `maxlength="16"` gets a 16-character password from the
      context menu. A field with `maxlength="8"` is not filled, and the
      message names the limit.
- [ ] A field inside a cross-origin iframe: the context menu and the popup
      both report that the field cannot be reached.
- [ ] On `chrome://extensions` the context-menu item is absent and **Fill in
      page** is disabled with a hint.
- [ ] After a browser restart the context menu holds the item exactly once.
- [ ] After a minute without use, the context menu still fills: the service
      worker was stopped and started again.
- [ ] `chrome://extensions/shortcuts` lists the command. The popup footer
      shows the assigned key, or "not set".
- [ ] The extension's **Errors** page at `chrome://extensions` is empty.
- [ ] With DevTools open on the popup, the Network panel shows only files of
      the extension.
- [ ] The popup is readable in the light and in the dark scheme, and in
      Portuguese with the browser language set to `pt-BR`.

Firefox 142 or later, with `dist/firefox` loaded as a temporary add-on:

- [ ] Every item of the Chrome list that does not name a `chrome://` page.
- [ ] The context-menu item appears on password fields as well as on text
      fields.
- [ ] `about:addons`, gear menu, Manage Extension Shortcuts lists the
      command.
- [ ] After a failed shortcut fill the reason is in the popup when it is
      opened by hand. Note whether Firefox opens the popup by itself.
- [ ] On `about:addons` the context-menu item is absent and **Fill in page**
      is disabled.
- [ ] The console of the extension, reached through **Inspect** on
      `about:debugging`, shows no errors.

Edge, with `dist/chrome` loaded at `edge://extensions`:

- [ ] Popup fill, context menu and shortcut, as in the Chrome list.
- [ ] `edge://extensions/shortcuts` lists the command.

macOS, in Chrome and in Firefox:

- [ ] The shortcut is `Control+Shift+G`, not `Command+Shift+G`. It is
      assigned and it fills.
- [ ] The popup has no horizontal scroll bar and no clipped text.

## Releases and stores

The extension is not in the Chrome Web Store, in Edge Add-ons or on
addons.mozilla.org (AMO). Nothing in this repository uploads to a store.

**GitHub releases.** The release workflow builds both targets with TinyGo at
the release tag and attaches three files to the GitHub release:
`secretgenerator-extension-<version>-chrome.zip`,
`secretgenerator-extension-<version>-firefox.zip` and
`extension-SHA256SUMS`. These files are not covered by the cosign-signed
`checksums.txt` of the release, nor by its SLSA provenance. Releases up to
v2.1.0 do not have them. The zips are not signed by a store either: unzip the
Chrome one and load it unpacked, and load the Firefox one as a temporary
add-on.

**Chrome Web Store and Edge Add-ons.** The Chrome zip is the package to
upload. Each upload needs a higher manifest version than the one before.
Store listings, screenshots and store icons have not been prepared, and
uploading the Chrome zip to Edge Add-ons has not been tried.

**addons.mozilla.org.**

- AMO needs the source code along with the package, because the package
  contains compiled WebAssembly and the output of `tsc`. Reviewers rebuild
  the package from that source and compare. The source to submit is the
  whole repository at the release tag: the Go core lives outside
  `extension/`.
- `npm run build-for-amo` builds the Firefox target with TinyGo and packages
  it. AMO's automatic source build looks for an npm script with this name.
  It is not known whether Go and TinyGo are available to that build, so
  expect a manual review and point the reviewers to
  [Build from source](#build-from-source).
- Tell the reviewers where your build environment differs from theirs. When
  this was written, their default environment was Ubuntu 24.04 on arm64 with
  Node.js 24. CI builds on Linux amd64 with Node.js 22. It has not been
  checked that TinyGo produces the same `keygen.wasm` on arm64.
- The add-on id in `browser_specific_settings.gecko.id` is
  `extension@secretgenerator.org`. It becomes permanent with the first
  submission. Change it before that, or never.
- The manifest declares `data_collection_permissions` as `none`. That stays
  true only as long as the extension makes no network requests and stores
  nothing but the options.
- Mozilla replaces its add-on policies on 2026-12-01. Read the
  [current policies](https://extensionworkshop.com/documentation/publish/add-on-policies/)
  and the
  [source code submission rules](https://extensionworkshop.com/documentation/publish/source-code-submission/)
  again before the first submission.

## Layout

```
src/            TypeScript, compiled by tsc to ES modules
  background.ts   service worker (Chrome, Edge) or background module (Firefox)
  popup/          popup page script
  lib/            shared modules, including the injected fill function
static/         copied into the build: popup markup and styles, icons, locales
scripts/        build and packaging scripts, Node.js built-ins only
test/unit/      unit tests (node:test)
test/e2e/       Playwright tests against the Chrome build
test/firefox/   geckodriver smoke test for the Firefox build
build/          intermediate output, not committed
dist/<target>/  unpacked extension per target, not committed
artifacts/      zips and SHA256SUMS, not committed
```
