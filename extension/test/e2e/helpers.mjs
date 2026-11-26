// Shared by the end-to-end tests. They load the unpacked Chrome build in
// Chromium through Playwright and drive it the way a user would, as far as
// automation can reach.
//
// The build under test is the real one, with the production permission
// set: there are no host permissions, so a page can only be filled after
// the browser has granted activeTab for its tab. See grantActiveTab().
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright";
import { EXT_ROOT } from "../../scripts/common.mjs";

/** dist/chrome, or another unpacked build of the Chrome target named by EXTENSION_DIR. */
export const EXTENSION_DIR = path.resolve(
  process.env.EXTENSION_DIR ?? path.join(EXT_ROOT, "dist", "chrome"),
);

export const MENU_ID = "fill-password";
export const COMMAND = "fill-password";

/**
 * A host name that the browser under test resolves to 127.0.0.1. Chromium
 * treats http://127.0.0.1 and http://localhost as secure contexts; under
 * this name a fixture page is an ordinary plain-http page.
 */
export const PLAIN_HTTP_HOST = "plain-http.test";

// lib/fill-flow.ts drops a shortcut that follows another one for the same
// tab within a second (key auto-repeat). Tests that send two commands to
// one tab wait this long in between.
export const COMMAND_REPEAT_WINDOW_MS = 1100;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readBuild(language) {
  const manifestFile = path.join(EXTENSION_DIR, "manifest.json");
  assert.ok(
    existsSync(manifestFile),
    `${manifestFile} does not exist. Run \`npm run build\` first.`,
  );
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  assert.ok(manifest.background?.service_worker, `${EXTENSION_DIR} is not the Chrome build`);
  // A UI language without a folder of its own gets the default locale.
  const own = path.join(EXTENSION_DIR, "_locales", language.replace("-", "_"), "messages.json");
  const fallback = path.join(EXTENSION_DIR, "_locales", manifest.default_locale, "messages.json");
  const messages = JSON.parse(readFileSync(existsSync(own) ? own : fallback, "utf8"));
  return { manifest, messages };
}

/**
 * The text of a message with its $1-style substitutions filled in, as
 * chrome.i18n.getMessage builds it.
 */
function messageText(messages, key, substitutions) {
  const entry = messages[key];
  assert.ok(entry, `no message "${key}"`);
  return entry.message.replace(/\$([A-Za-z0-9_@]+)\$/g, (_, name) => {
    const content = entry.placeholders?.[name.toLowerCase()]?.content ?? "";
    return content.replace(/\$([1-9])/g, (_match, index) => substitutions[index - 1] ?? "");
  });
}

/**
 * Starts Chromium with the extension loaded and waits for its service
 * worker. Extensions need a persistent context, and headless mode loads
 * them only in the full browser (`channel: "chromium"`), not in the
 * headless shell.
 *
 * @param {{ language?: string }} [options] UI language of the browser,
 *   which is what chrome.i18n follows. English unless a test asks for
 *   another one, whatever the machine is set to.
 */
export async function launchExtension({ language = "en-US" } = {}) {
  const { manifest, messages } = readBuild(language);
  const context = await chromium.launchPersistentContext("", {
    headless: true,
    channel: "chromium",
    locale: language,
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
      `--lang=${language}`,
      `--host-resolver-rules=MAP ${PLAIN_HTTP_HOST} 127.0.0.1`,
    ],
    // On Linux, Chromium takes its UI language from the environment.
    env: { ...process.env, LANGUAGE: language.replace("-", "_") },
  });
  try {
    // An invalid manifest makes Chrome skip the extension without a word;
    // the missing worker is then the only symptom.
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker", { timeout: 15_000 }).catch(() => {
        throw new Error(
          `the extension in ${EXTENSION_DIR} did not start a service worker; Chrome skips an extension with an invalid manifest silently`,
        );
      }));
    const id = new URL(worker.url()).host;
    // CSP violations are console errors too, but the event names the
    // directive and the blocked URL. Init scripts are injected by the
    // browser and are not subject to the page's CSP.
    await context.addInitScript(() => {
      globalThis.__cspViolations = [];
      document.addEventListener("securitypolicyviolation", (event) => {
        globalThis.__cspViolations.push(`${event.violatedDirective}: ${event.blockedURI}`);
      });
    });
    return {
      context,
      id,
      manifest,
      popupUrl: `chrome-extension://${id}/${manifest.action.default_popup}`,
      message: (key, ...substitutions) => messageText(messages, key, substitutions),
      /** The current worker: Chrome replaces it after it was stopped. */
      worker: () => context.serviceWorkers().find((w) => new URL(w.url()).host === id) ?? worker,
      close: () => context.close(),
    };
  } catch (error) {
    await context.close();
    throw error;
  }
}

/**
 * Opens popup.html as a tab and waits until it has rendered. `query` may
 * name the tab to fill ("?tabId=12"), which is how the popup is pointed at
 * a page when it is not opened from the toolbar.
 *
 * Returns the page and everything it printed, threw or failed to load.
 */
export async function openPopup(extension, query = "") {
  const page = await extension.context.newPage();
  const problems = [];
  // Every message counts, whatever its level: the extension's own code has
  // no console calls, so anything here comes from the browser or the WASM
  // shim and says that something went wrong.
  page.on("console", (message) => problems.push(`console ${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => problems.push(`uncaught: ${error.message}`));
  page.on("requestfailed", (request) =>
    problems.push(`request failed: ${request.url()} ${request.failure()?.errorText ?? ""}`),
  );
  await page.goto(extension.popupUrl + query);
  await page.waitForFunction(() => document.body.dataset.ready === "true", null, {
    timeout: 20_000,
  });
  return {
    page,
    /** Console messages, uncaught errors, failed requests and CSP violations so far. */
    problems: async () => [
      ...problems,
      ...(await page.evaluate(() => globalThis.__cspViolations)).map((v) => `CSP violation: ${v}`),
    ],
  };
}

/**
 * A local web server for fixture pages: { "/path": "<html>" }. The map is
 * read on every request, so a page whose markup needs the server's address
 * can be added after the server has started.
 */
export async function serveFixtures(routes) {
  const server = http.createServer((request, response) => {
    const body = routes[new URL(request.url, "http://fixture").pathname];
    if (body === undefined) {
      response.writeHead(404).end("not found");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        // close() alone waits for the browser to give up the connections
        // it keeps open, which takes a minute for one that sent no request.
        server.closeAllConnections();
      }),
  };
}

/** The tab that shows `page`, as the extension sees it. */
export async function tabOf(extension, page) {
  await page.bringToFront();
  const tab = await extension
    .worker()
    .evaluate(
      async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0] ?? null,
    );
  assert.ok(tab, "the extension sees no active tab");
  return tab;
}

/**
 * Grants activeTab for the tab that shows `page`, through the DevTools
 * command that stands for a click on the toolbar button. Like the click,
 * it also opens the real action popup.
 *
 * A context-menu click and the keyboard shortcut grant activeTab as well,
 * but automation cannot perform either. The tests dispatch those two
 * events inside the worker and rely on this grant for the page access.
 */
export async function grantActiveTab(extension, page) {
  const session = await extension.context.browser().newBrowserCDPSession();
  try {
    const { targetInfos } = await session.send("Target.getTargets", { filter: [{ type: "tab" }] });
    // Tab targets can only be told apart by what they show.
    const targets = targetInfos.filter((info) => info.url === page.url());
    assert.equal(targets.length, 1, `expected one tab that shows ${page.url()}`);
    await session.send("Extensions.triggerAction", {
      id: extension.id,
      targetId: targets[0].targetId,
    });
  } finally {
    await session.detach();
  }
  // Without the "tabs" permission a tab has a url only where the extension
  // has access, so the url appearing is the grant taking effect.
  const deadline = Date.now() + 5000;
  for (;;) {
    const tab = await tabOf(extension, page);
    if (tab.url === page.url()) return tab;
    assert.ok(Date.now() < deadline, "activeTab was not granted within 5 s");
    await sleep(50);
  }
}

// chrome.<event>.dispatch() calls the listeners the extension registered,
// exactly as the browser does, and returns their return values. The
// listeners return the promise of the whole fill, so awaiting the results
// waits for the fill to end.
async function dispatch(extension, event, args) {
  const settled = await extension.worker().evaluate(
    async ({ event, args }) => {
      const [namespace, name] = event.split(".");
      const returned = chrome[namespace][name].dispatch(...args);
      const results = await Promise.allSettled(returned?.results ?? []);
      return results.map((result) => result.status);
    },
    { event, args },
  );
  // runFill never rejects: a rejected listener would be an unreported failure.
  assert.deepEqual(settled, ["fulfilled"], `${event} listener`);
}

/** Delivers a click on the extension's context-menu item in a frame of `tab`. */
export function clickMenuItem(extension, tab, frameId = 0) {
  return dispatch(extension, "contextMenus.onClicked", [
    { menuItemId: MENU_ID, frameId, editable: true, pageUrl: tab.url },
    tab,
  ]);
}

/** Delivers the fill shortcut for `tab`. */
export function pressShortcut(extension, tab) {
  return dispatch(extension, "commands.onCommand", [COMMAND, tab]);
}

/** Badge text and tooltip of the toolbar button for a tab. */
export function badgeOf(extension, tabId) {
  return extension.worker().evaluate(
    async (tabId) => ({
      text: await chrome.action.getBadgeText({ tabId }),
      title: await chrome.action.getTitle({ tabId }),
    }),
    tabId,
  );
}

/** Everything in both storage areas, as the extension sees it. */
export function storageOf(extension) {
  return extension.worker().evaluate(async () => ({
    local: await chrome.storage.local.get(null),
    session: await chrome.storage.session.get(null),
  }));
}

/**
 * Starts recording every storage change in the running worker and returns
 * a function that reads the record. A notice left for the popup is taken
 * out of storage as soon as a popup opens, so storage alone cannot show
 * that it was ever there.
 */
export async function watchStorage(extension) {
  await extension.worker().evaluate(() => {
    globalThis.__storageChanges = [];
    chrome.storage.onChanged.addListener((changes, area) => {
      for (const [key, change] of Object.entries(changes)) {
        globalThis.__storageChanges.push({ area, key, value: change.newValue ?? null });
      }
    });
  });
  return () => extension.worker().evaluate(() => globalThis.__storageChanges);
}

/**
 * Turns on Chrome's error log for the extension and returns a function
 * that reads it. The log is what chrome://extensions shows under "Errors":
 * uncaught exceptions and unchecked runtime.lastError values of the worker,
 * which no page event reports. It only records while developer mode and
 * error collection are on, and only that page can switch them on, through
 * the private API it is built with.
 */
export async function collectExtensionErrors(extension) {
  const page = await extension.context.newPage();
  await page.goto("chrome://extensions");
  await page.waitForFunction(() => Boolean(chrome.developerPrivate), null, { timeout: 10_000 });
  await page.evaluate(
    (extensionId) =>
      new Promise((resolve) => {
        chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, () =>
          chrome.developerPrivate.updateExtensionConfiguration(
            { extensionId, errorCollection: true },
            resolve,
          ),
        );
      }),
    extension.id,
  );
  return () =>
    page.evaluate(async (extensionId) => {
      const all = await new Promise((resolve) =>
        chrome.developerPrivate.getExtensionsInfo(
          { includeDisabled: true, includeTerminated: true },
          resolve,
        ),
      );
      const info = all.find((extension) => extension.id === extensionId);
      return {
        collecting: info.errorCollection.isActive,
        manifestErrors: info.manifestErrors.map((error) => error.message),
        runtimeErrors: info.runtimeErrors.map((error) => error.message),
        installWarnings: info.installWarnings ?? [],
      };
    }, extension.id);
}

/**
 * Stops the extension's service worker and starts it again, as the browser
 * does when the worker was idle and the next event arrives. Everything the
 * worker kept in memory is gone afterwards, the WASM instance included.
 */
export async function restartWorker(extension, page) {
  const session = await extension.context.newCDPSession(page);
  try {
    const statuses = [];
    session.on("ServiceWorker.workerVersionUpdated", (event) => {
      for (const version of event.versions) statuses.push(version.runningStatus);
    });
    const waitFor = async (status) => {
      const deadline = Date.now() + 10_000;
      while (statuses.at(-1) !== status) {
        assert.ok(Date.now() < deadline, `the worker did not reach "${status}": ${statuses}`);
        await sleep(50);
      }
    };
    await session.send("ServiceWorker.enable");
    await session.send("ServiceWorker.stopAllWorkers");
    await waitFor("stopped");
    await session.send("ServiceWorker.startWorker", {
      scopeURL: `chrome-extension://${extension.id}/`,
    });
    await waitFor("running");
  } finally {
    await session.detach();
  }
}

/**
 * Access to the real action popup, the one the browser opens below the
 * toolbar button. It is not a tab, so Playwright has no page for it. A
 * second page of the extension, kept in a background tab, reaches its
 * window instead: pages of one extension can see each other.
 */
export async function watchActionPopup(extension) {
  const { page } = await openPopup(extension);
  const state = () =>
    page.evaluate(() => {
      const view = chrome.extension.getViews({ type: "popup" })[0];
      if (!view?.document.body) return null;
      const element = (id) => view.document.getElementById(id);
      return {
        ready: view.document.body.dataset.ready === "true",
        notice: element("notice").hidden ? null : element("notice").textContent,
        output: element("output").textContent,
        status: element("status").textContent,
        statusState: element("status").dataset.state ?? null,
      };
    });
  return {
    /** What the popup shows, or null while none is open. */
    state,
    /** Waits until an open popup satisfies `predicate` and returns its state. */
    async waitFor(what, predicate) {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const current = await state();
        if (current && predicate(current)) return current;
        assert.ok(
          Date.now() < deadline,
          `timed out waiting for ${what}: ${JSON.stringify(current)}`,
        );
        await sleep(50);
      }
    },
    click: (id) =>
      page.evaluate(
        (id) => chrome.extension.getViews({ type: "popup" })[0].document.getElementById(id).click(),
        id,
      ),
    /**
     * Types into an option field and closes the popup in the same task,
     * before any timer of the popup can run.
     */
    typeAndClose: (id, value) =>
      page.evaluate(
        ({ id, value }) => {
          const view = chrome.extension.getViews({ type: "popup" })[0];
          const input = view.document.getElementById(id);
          input.value = value;
          input.dispatchEvent(new view.Event("input", { bubbles: true }));
          view.close();
        },
        { id, value },
      ),
    /** Closes the popup if one is open, as clicking elsewhere would. */
    async close() {
      await page.evaluate(() => {
        for (const view of chrome.extension.getViews({ type: "popup" })) view.close();
      });
      const deadline = Date.now() + 5000;
      while ((await state()) !== null) {
        assert.ok(Date.now() < deadline, "the action popup did not close");
        await sleep(50);
      }
    },
    dispose: () => page.close(),
  };
}
