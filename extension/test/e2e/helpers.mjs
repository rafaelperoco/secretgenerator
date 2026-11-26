// Shared by the end-to-end tests. They load the unpacked Chrome build in
// Chromium through Playwright and drive it the way a user would, as far as
// automation can reach.
//
// The build has no host permissions: a page can only be scripted after the
// browser has granted activeTab for its tab, which takes a user gesture.
// How the tests obtain that right is decided once per browser start, see
// launchExtension(), and printed as "[e2e] page access: ...".
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(HERE, "..", "..");
const FIXTURES_DIR = path.join(HERE, "fixtures");

/**
 * The build that ships: dist/chrome, or another unpacked build of the
 * Chrome target named by EXTENSION_DIR (an unzipped package, for example).
 * Nothing here ever writes to it.
 */
export const SHIPPED_DIR = path.resolve(
  process.env.EXTENSION_DIR ?? path.join(EXT_ROOT, "dist", "chrome"),
);

export const MENU_ID = "fill-password";
export const COMMAND = "fill-password";

// lib/fill-flow.ts drops a shortcut that follows another one for the same
// tab within a second (key auto-repeat). The window is a span of time, so
// the one test that presses twice in the same tab has to let it pass.
export const COMMAND_REPEAT_WINDOW_MS = 1100;

// Fixture pages are served from one local server that the browser reaches
// under several names (see --host-resolver-rules below), each of them a
// different origin:
//   127.0.0.1         the pages the tests fill;
//   foreign.test      another site: frames the extension must not reach and
//                     tabs the user never acted on;
//   plain-http.test   a page that is not a secure context. Chromium treats
//                     http://127.0.0.1 and http://localhost as secure.
const FOREIGN_HOST = "foreign.test";
const PLAIN_HTTP_HOST = "plain-http.test";

// The match patterns the fallback build is given (see launchExtension).
// foreign.test is left out on purpose: it has to stay out of reach.
export const FALLBACK_HOST_PERMISSIONS = [
  "http://127.0.0.1/*",
  "http://localhost/*",
  `http://${PLAIN_HTTP_HOST}/*`,
];

// E2E_PAGE_ACCESS=activeTab fails instead of falling back; =host-permissions
// goes straight to the fallback. Unset, the first one that works is used.
const ACCESS_ENV = "E2E_PAGE_ACCESS";
const ACCESS_MODES = ["auto", "activeTab", "host-permissions"];

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function show(value) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Calls `read` until `accept` likes what it returned, and returns that.
 * For conditions that live outside a page, where Playwright cannot wait.
 */
export async function until(what, read, accept = Boolean, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}; last saw ${show(value)}`);
    await sleep(25);
  }
}

function readBuild(language) {
  const manifestFile = path.join(SHIPPED_DIR, "manifest.json");
  assert.ok(
    existsSync(manifestFile),
    `${manifestFile} does not exist. Run \`npm run build\` first.`,
  );
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  assert.ok(manifest.background?.service_worker, `${SHIPPED_DIR} is not the Chrome build`);
  // A UI language without a folder of its own gets the default locale.
  const own = path.join(SHIPPED_DIR, "_locales", language.replace("-", "_"), "messages.json");
  const fallback = path.join(SHIPPED_DIR, "_locales", manifest.default_locale, "messages.json");
  const messages = JSON.parse(readFileSync(existsSync(own) ? own : fallback, "utf8"));
  return { manifest, messages };
}

/** The shipped manifest, read from disk. Fails with the build hint when it is missing. */
export const shippedManifest = () => readBuild("en").manifest;

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

const CONTENT_TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript" };

/**
 * Serves the files of test/e2e/fixtures/ on a free local port. Only the
 * names read here are served, so a request cannot reach other files.
 */
async function serveFixtures() {
  const files = new Map(
    readdirSync(FIXTURES_DIR).map((name) => [
      `/${name}`,
      {
        body: readFileSync(path.join(FIXTURES_DIR, name)),
        type: CONTENT_TYPES[path.extname(name)],
      },
    ]),
  );
  const server = http.createServer((request, response) => {
    const file = files.get(new URL(request.url, "http://fixture").pathname);
    if (!file?.type) {
      response.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    response.writeHead(200, { "content-type": file.type, "cache-control": "no-store" });
    response.end(file.body);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: server.address().port,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        // close() alone waits for the browser to give up the connections
        // it keeps open, which takes a minute for one that sent no request.
        server.closeAllConnections();
      }),
  };
}

/**
 * A temporary copy of the shipped build whose manifest also asks for the
 * fixture hosts. The copy is what the browser loads in the fallback mode;
 * the shipped directory is only read.
 */
function copyWithHostPermissions() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "secretgenerator-e2e-"));
  try {
    cpSync(SHIPPED_DIR, dir, { recursive: true });
    const file = path.join(dir, "manifest.json");
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    manifest.host_permissions = FALLBACK_HOST_PERMISSIONS;
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return dir;
}

/**
 * Starts Chromium with the unpacked extension in `dir` and waits for its
 * service worker. Extensions need a persistent context, and headless mode
 * loads them only in the full browser (`channel: "chromium"`), not in the
 * headless shell.
 */
async function startBrowser(dir, { language, headless, extraArgs = [] }) {
  const context = await chromium.launchPersistentContext("", {
    headless,
    channel: "chromium",
    locale: language,
    args: [
      `--disable-extensions-except=${dir}`,
      `--load-extension=${dir}`,
      `--lang=${language}`,
      `--host-resolver-rules=MAP *.test 127.0.0.1`,
      // Everything the tests load is local. A proxy from the environment
      // would be asked for the .test names, which only exist in here.
      "--no-proxy-server",
      ...extraArgs,
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
          `the extension in ${dir} did not start a service worker; Chrome skips an extension with an invalid manifest silently`,
        );
      }));
    // CSP violations are console errors too, but the event names the
    // directive and the blocked URL. Init scripts are injected by the
    // browser and are not subject to the page's CSP.
    await context.addInitScript(() => {
      globalThis.__cspViolations = [];
      document.addEventListener("securitypolicyviolation", (event) => {
        globalThis.__cspViolations.push(`${event.violatedDirective}: ${event.blockedURI}`);
      });
    });
    return { context, id: new URL(worker.url()).host };
  } catch (error) {
    await context.close();
    throw error;
  }
}

/**
 * Starts the fixture server and the browser with the extension, and settles
 * how the tests get access to a fixture page:
 *
 *  - "activeTab": the shipped build, unchanged. The DevTools command
 *    Extensions.triggerAction stands for a click on the toolbar button; like
 *    the click it grants activeTab for the tab and opens the real action
 *    popup. The command is experimental: some Chromium versions only have
 *    it behind --enable-unsafe-extension-debugging, older ones not at all.
 *  - "host-permissions": where that command cannot be had, the browser
 *    loads a temporary copy of the build whose manifest lists the fixture
 *    hosts. Everything else in the copy is the shipped build. This mode
 *    cannot show that the extension works with activeTab alone.
 *
 * A context-menu click and the keyboard shortcut grant activeTab as well,
 * but automation can perform neither. The tests dispatch those two events
 * inside the worker and rely on the access obtained here.
 *
 * @param {{ language?: string, headless?: boolean, pages?: boolean }} [options]
 *   `language` is the UI language of the browser, which is what chrome.i18n
 *   follows: English unless a test asks for another one, whatever the
 *   machine is set to. `pages: false` is for tests that open no fixture
 *   page: the shipped build is loaded and no access is set up.
 */
export async function launchExtension({ language = "en-US", headless = true, pages = true } = {}) {
  const { manifest, messages } = readBuild(language);
  const requested = process.env[ACCESS_ENV] ?? "auto";
  assert.ok(
    ACCESS_MODES.includes(requested),
    `${ACCESS_ENV} must be one of ${ACCESS_MODES.join(", ")}, not "${requested}"`,
  );

  const closers = [];
  const closeAll = async () => {
    for (const close of closers.reverse()) await Promise.resolve(close()).catch(() => {});
    closers.length = 0;
  };

  try {
    const server = pages ? await serveFixtures() : null;
    if (server) closers.push(server.close);

    // Candidates in order of preference. The first whose page access
    // works is kept.
    const candidates = [];
    if (!pages) {
      candidates.push({ mode: "none", how: "no fixture pages", extraArgs: [] });
    } else if (requested !== "host-permissions") {
      candidates.push(
        { mode: "activeTab", how: "CDP Extensions.triggerAction", extraArgs: [] },
        {
          mode: "activeTab",
          how: "CDP Extensions.triggerAction with --enable-unsafe-extension-debugging",
          extraArgs: ["--enable-unsafe-extension-debugging"],
        },
      );
    }
    if (pages && requested !== "activeTab") {
      candidates.push({
        mode: "host-permissions",
        how: `a temporary copy of the build with host_permissions ${JSON.stringify(FALLBACK_HOST_PERMISSIONS)}`,
        extraArgs: [],
      });
    }

    const refusals = [];
    for (const candidate of candidates) {
      let dir = SHIPPED_DIR;
      const undo = [];
      if (candidate.mode === "host-permissions") {
        dir = copyWithHostPermissions();
        const remove = () => rmSync(dir, { recursive: true, force: true });
        // Also when the process dies before close() ran.
        process.once("exit", remove);
        undo.push(() => {
          process.removeListener("exit", remove);
          remove();
        });
      }
      const browser = await startBrowser(dir, {
        language,
        headless,
        extraArgs: candidate.extraArgs,
      }).catch((error) => {
        for (const step of undo) step();
        throw error;
      });
      undo.push(() => browser.context.close());
      const closeCandidate = async () => {
        for (const step of undo.reverse()) await Promise.resolve(step()).catch(() => {});
      };
      closers.push(closeCandidate);

      const extension = createExtension({
        ...browser,
        manifest,
        messages,
        port: server?.port ?? 0,
        access: { mode: candidate.mode, how: candidate.how },
        close: closeAll,
      });
      const refusal = await extension.prepare();
      if (refusal === null) {
        const dropped = refusals.length ? ` (${refusals.join("; ")})` : "";
        // Printed, not only returned: which of the two modes ran decides
        // what a green run says about the shipped permissions.
        if (pages) {
          console.log(`[e2e] page access: ${candidate.mode}, through ${candidate.how}${dropped}`);
        }
        return extension;
      }
      refusals.push(`${candidate.how}: ${refusal}`);
      closers.pop();
      await closeCandidate();
    }
    throw new Error(`no way to get access to a fixture page. ${refusals.join("; ")}`);
  } catch (error) {
    await closeAll();
    throw error;
  }
}

function createExtension({ context, id, manifest, messages, port, access, close }) {
  const popupUrl = `chrome-extension://${id}/${manifest.action.default_popup}`;
  const origin = `http://127.0.0.1:${port}`;
  // A second page of the extension, kept in a background tab for the whole
  // run. Pages of one extension can see each other, so it reaches the real
  // action popup (which is not a tab and has no Playwright page), and its
  // record of storage changes survives a restart of the service worker.
  let observer = null;
  // Whether this browser shows an action popup at all when asked to.
  let popupOpens = false;
  // Pages opened for the running test: closed by endTest().
  const pages = new Set();
  const popups = [];
  let fixtureCount = 0;

  const worker = () => {
    // The newest one, should a stopped worker still be listed.
    const found = context.serviceWorkers().findLast((w) => new URL(w.url()).host === id);
    assert.ok(found, "the extension's service worker is not running");
    return found;
  };

  const inObserver = (fn, arg) => observer.evaluate(fn, arg);

  /** The tab that shows `page`, as the extension sees it. */
  async function tabOf(page) {
    await page.bringToFront();
    const tab = await worker().evaluate(
      async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0] ?? null,
    );
    assert.ok(tab, "the extension sees no active tab");
    return tab;
  }

  const actionPopup = {
    /** What the real action popup shows, or null while none is open. */
    state: () =>
      inObserver(() => {
        const view = chrome.extension.getViews({ type: "popup" })[0];
        if (!view?.document.body) return null;
        const element = (name) => view.document.getElementById(name);
        return {
          ready: view.document.body.dataset.ready === "true",
          notice: element("notice").hidden ? null : element("notice").textContent,
          output: element("output").textContent,
          status: element("status").textContent,
          statusState: element("status").dataset.state ?? null,
          fillEnabled: !element("btn-fill").disabled,
          fillHint: element("fill-hint").hidden ? null : element("fill-hint").textContent,
        };
      }),
    /**
     * The size the browser gave the popup's window and the size its
     * content asks for, in CSS pixels. Only a browser with a window sizes
     * the popup to its content.
     */
    measure: () =>
      inObserver(() => {
        const view = chrome.extension.getViews({ type: "popup" })[0];
        if (!view?.document.body) return null;
        const root = view.document.documentElement;
        return {
          selected: view.document.querySelector('[role="tab"][aria-selected="true"]')?.id,
          width: view.innerWidth,
          height: view.innerHeight,
          scrollWidth: root.scrollWidth,
          scrollHeight: root.scrollHeight,
          contentHeight: Math.ceil(view.document.body.getBoundingClientRect().height),
        };
      }),
    /** Waits until an open popup satisfies `predicate` and returns its state. */
    waitFor: (what, predicate, timeout) =>
      until(what, actionPopup.state, (state) => state !== null && predicate(state), timeout),
    click: (name) =>
      inObserver(
        (name) =>
          chrome.extension.getViews({ type: "popup" })[0].document.getElementById(name).click(),
        name,
      ),
    /**
     * Types into an option field and closes the popup in the same task,
     * before any timer of the popup can run.
     */
    typeAndClose: (name, value) =>
      inObserver(
        ({ name, value }) => {
          const view = chrome.extension.getViews({ type: "popup" })[0];
          const input = view.document.getElementById(name);
          input.value = value;
          input.dispatchEvent(new view.Event("input", { bubbles: true }));
          view.close();
        },
        { name, value },
      ),
    /** Closes the popup if one is open, as clicking elsewhere would. */
    async close() {
      await inObserver(() => {
        for (const view of chrome.extension.getViews({ type: "popup" })) view.close();
      });
      await until("the action popup to close", actionPopup.state, (state) => state === null);
    },
    /**
     * Opens the real popup for the tab that shows `page`: with the toolbar
     * click where the tests have it, otherwise with the API call the
     * extension itself uses after a failed fill.
     */
    async open(page) {
      await actionPopup.close();
      const tab = await tabOf(page);
      if (access.mode === "activeTab") await triggerAction(page);
      else await worker().evaluate(() => chrome.action.openPopup());
      await actionPopup.waitFor("the action popup to render", (state) => state.ready);
      return tab;
    },
  };

  /** The DevTools stand-in for a click on the toolbar button, for the tab of `page`. */
  async function triggerAction(page) {
    const session = await context.browser().newBrowserCDPSession();
    try {
      const { targetInfos } = await session.send("Target.getTargets", {
        filter: [{ type: "tab" }],
      });
      // The command wants the tab, not the page inside it, and tab targets
      // can only be told apart by what they show. openFixture() gives every
      // page a URL of its own for that reason.
      const targets = targetInfos.filter((info) => info.url === page.url());
      assert.equal(targets.length, 1, `expected one tab that shows ${page.url()}`);
      await session.send("Extensions.triggerAction", { id, targetId: targets[0].targetId });
    } finally {
      await session.detach().catch(() => {});
    }
  }

  /**
   * Makes the tab of `page` one the extension may script, and returns the
   * tab. The page has to be on a host the current mode can reach.
   */
  async function grantAccess(page) {
    if (access.mode === "host-permissions") {
      const tab = await tabOf(page);
      assert.equal(tab.url, page.url(), "the fallback host permissions do not cover this page");
      return tab;
    }
    await actionPopup.close();
    const before = await tabOf(page);
    await triggerAction(page);
    // Without the "tabs" permission a tab has a url only where the
    // extension has access, so the url appearing is the grant taking effect.
    const tab = await until(
      "activeTab to be granted",
      () => worker().evaluate((tabId) => chrome.tabs.get(tabId), before.id),
      (tab) => tab.url === page.url(),
      5000,
    );
    // The same click opened the popup. It is closed again, once it is
    // there, so that it cannot take a notice meant for a later popup.
    if (popupOpens) {
      await actionPopup.waitFor("the action popup to open", () => true);
      await actionPopup.close();
    }
    return tab;
  }

  /**
   * Opens popup.html as a tab and waits until it has rendered. `query` may
   * name the tab to fill ("?tabId=12"), which is how the popup is pointed
   * at a page when it is not opened from the toolbar.
   *
   * Returns the page and a function that lists everything the page
   * printed, threw, failed to load or was refused by its CSP. endTest()
   * reports the same list for every popup of a test.
   */
  async function openPopup(query = "") {
    const page = await context.newPage();
    pages.add(page);
    const problems = [];
    // Every message counts, whatever its level: the extension's own code
    // has no console calls, so anything here comes from the browser or the
    // WASM shim and says that something went wrong.
    page.on("console", (message) => problems.push(`console ${message.type()}: ${message.text()}`));
    page.on("pageerror", (error) => problems.push(`uncaught: ${error.message}`));
    page.on("requestfailed", (request) =>
      problems.push(`request failed: ${request.url()} ${request.failure()?.errorText ?? ""}`),
    );
    const popup = {
      page,
      /** Drops what was collected so far, for a test that provoked it. */
      forget: () => problems.splice(0),
      problems: async () => [
        ...problems,
        ...(page.isClosed() ? [] : await page.evaluate(() => globalThis.__cspViolations)).map(
          (violation) => `CSP violation: ${violation}`,
        ),
      ],
    };
    popups.push(popup);
    await page.goto(popupUrl + query);
    await page.waitForFunction(() => document.body.dataset.ready === "true", null, {
      timeout: 20_000,
    });
    return popup;
  }

  /**
   * Opens a fixture page in a new tab.
   *
   * @param {string} file A file of test/e2e/fixtures/, optionally with a query.
   * @param {{ origin?: string, access?: boolean }} [options] `origin` is one
   *   of the extension's origins; `access: false` leaves the tab as the
   *   browser gives it to an extension the user has not invoked there.
   * @returns {Promise<{ page: import("playwright").Page, tab: object }>}
   */
  async function openFixture(file, { origin: from = origin, access: wanted = true } = {}) {
    const url = new URL(file, `${from}/`);
    // Unique per page: see triggerAction().
    url.searchParams.set("page", String(++fixtureCount));
    const page = await context.newPage();
    pages.add(page);
    await page.goto(url.href);
    const tab = wanted ? await grantAccess(page) : await tabOf(page);
    return { page, tab };
  }

  // chrome.<event>.dispatch() calls the listeners the extension registered,
  // exactly as the browser does, and returns their return values. The
  // listeners return the promise of the whole fill, so awaiting the results
  // waits for the fill to end. `times` delivers the event that often in one
  // go, before any of the fills has got anywhere.
  async function dispatch(event, args, times = 1) {
    const settled = await worker().evaluate(
      async ({ event, args, times }) => {
        const [namespace, name] = event.split(".");
        const pending = [];
        for (let i = 0; i < times; i++) {
          pending.push(...(chrome[namespace][name].dispatch(...args)?.results ?? []));
        }
        return (await Promise.allSettled(pending)).map((result) => result.status);
      },
      { event, args, times },
    );
    // runFill never rejects: a rejected listener would be an unreported failure.
    assert.deepEqual(settled, Array(times).fill("fulfilled"), `${event} listener`);
  }

  const extension = {
    context,
    id,
    /** The manifest as shipped, whatever the browser was given. */
    manifest,
    popupUrl,
    access,
    origin,
    /** Another site: never reachable for the extension, in either mode. */
    foreignOrigin: `http://${FOREIGN_HOST}:${port}`,
    /** The fixture pages outside a secure context. */
    plainHttpOrigin: `http://${PLAIN_HTTP_HOST}:${port}`,
    message: (key, ...substitutions) => messageText(messages, key, substitutions),
    /** The current worker: Chrome replaces it after it was stopped. */
    worker,
    tabOf,
    grantAccess,
    openPopup,
    openFixture,
    actionPopup,
    /** Whether this browser shows the action popup when it is asked to. */
    get popupOpens() {
      return popupOpens;
    },

    /**
     * Opens the observer page and tries the page access of this browser.
     * Returns null when it works, otherwise why it does not.
     */
    async prepare() {
      observer = await context.newPage();
      await observer.goto(popupUrl);
      await observer.waitForFunction(() => document.body.dataset.ready === "true", null, {
        timeout: 20_000,
      });
      await inObserver(() => {
        globalThis.__storageChanges = [];
        chrome.storage.onChanged.addListener((changes, area) => {
          for (const [key, change] of Object.entries(changes)) {
            globalThis.__storageChanges.push({ area, key, value: change.newValue ?? null });
          }
        });
      });

      if (access.mode === "none") return null;
      const page = await context.newPage();
      try {
        await page.goto(`${origin}/blank.html?probe`);
        const tab = await tabOf(page);
        let asked = true;
        if (access.mode === "host-permissions") {
          if (tab.url !== page.url()) return "the host permissions were not applied";
          // No toolbar click here. The popup is asked for the way the
          // extension asks after a failed fill.
          asked = await worker()
            .evaluate(() => chrome.action.openPopup())
            .then(
              () => true,
              () => false,
            );
        } else {
          try {
            await triggerAction(page);
          } catch (error) {
            return String(error.message)
              .split("\n")[0]
              .replace(/^cdpSession\.send: /, "");
          }
          const granted = await until(
            "activeTab",
            () => worker().evaluate((tabId) => chrome.tabs.get(tabId), tab.id),
            (tab) => tab.url === page.url(),
            5000,
          ).catch(() => null);
          if (!granted) return "the command ran, but the tab was not granted activeTab";
        }
        popupOpens =
          asked &&
          (await actionPopup
            .waitFor("the action popup", (state) => state.ready, 5000)
            .then(
              () => true,
              () => false,
            ));
        await actionPopup.close();
        return null;
      } finally {
        await page.close();
      }
    },

    /** Delivers a click on the extension's context-menu item in a frame of `tab`. */
    clickMenuItem: (tab, frameId = 0) =>
      dispatch("contextMenus.onClicked", [
        { menuItemId: MENU_ID, frameId, editable: true, pageUrl: tab.url },
        tab,
      ]),

    /**
     * Delivers the fill shortcut for `tab`. With `times` above one it
     * arrives that often at once, as it does while the key is held down.
     */
    pressShortcut: (tab, times = 1) => dispatch("commands.onCommand", [COMMAND, tab], times),

    /** Badge text and tooltip of the toolbar button for a tab. */
    badgeOf: (tabId) =>
      worker().evaluate(
        async (tabId) => ({
          text: await chrome.action.getBadgeText({ tabId }),
          title: await chrome.action.getTitle({ tabId }),
        }),
        tabId,
      ),

    /** Everything in both storage areas, as the extension sees it. */
    storage: () =>
      inObserver(async () => ({
        local: await chrome.storage.local.get(null),
        session: await chrome.storage.session.get(null),
      })),

    /**
     * Every storage write since the browser started: { area, key, value }.
     * A notice left for the popup is taken out of storage as soon as a
     * popup opens, so storage alone cannot show that it was ever there.
     */
    storageChanges: () => inObserver(() => globalThis.__storageChanges),

    /**
     * Ends a test: closes the pages it opened and any action popup, and
     * returns what the popup pages of the test printed, threw or were
     * refused, which has to be nothing.
     */
    async endTest() {
      const problems = [];
      for (const popup of popups.splice(0)) problems.push(...(await popup.problems()));
      for (const page of pages) await page.close();
      pages.clear();
      await actionPopup.close();
      return problems;
    },

    close,
  };
  return extension;
}

/**
 * Runs `action` in a popup page and returns the status it reports next:
 * { state: "ok" | "bad", text }. The status line may still show the result
 * of the action before, so its mere presence says nothing.
 */
export async function nextStatus(page, action) {
  // Wrapped in an object: a bare promise would be awaited here, before
  // the action ran.
  const seen = await page.evaluateHandle(() => ({
    status: new Promise((resolve) => {
      const status = document.getElementById("status");
      new MutationObserver((_records, observer) => {
        if (!status.dataset.state) return;
        observer.disconnect();
        resolve({ state: status.dataset.state, text: status.textContent });
      }).observe(status, { attributes: true, childList: true });
    }),
  }));
  await action();
  return seen.evaluate((seen) => seen.status);
}

/**
 * Makes a page report the window focus it really has. Playwright tells
 * every page that it is focused, which would hide a fill that depends on
 * the focus: under an open action popup document.hasFocus() is false,
 * although each document still knows its activeElement.
 *
 * It stays that way for the rest of the page's life. The DevTools session
 * that asked for it is left open on purpose and goes away with the page:
 * what a browser does to the setting when the session ends has changed
 * between Chromium versions.
 */
export async function showRealFocus(extension, page) {
  const session = await extension.context.newCDPSession(page);
  await session.send("Emulation.setFocusEmulationEnabled", { enabled: false });
}

/**
 * Presses Fill in a popup tab while the page to fill is in the state a real
 * popup leaves it in, without the window focus, and returns the status the
 * popup reports. The tests focus fields with element.focus() afterwards,
 * which does not need the window focus.
 */
export async function fillFromPopup(extension, popup, fixture) {
  await showRealFocus(extension, fixture);
  // Typing into a page gives it the focus even in a background tab, so
  // the page goes to the front first to have a focus to lose. Bringing the
  // popup's tab to the front then takes it away, as opening a popup does.
  await fixture.bringToFront();
  await popup.page.bringToFront();
  // Without this the test would not show what it is for.
  await until(
    "the page to lose the window focus",
    () => fixture.evaluate(() => document.hasFocus()),
    (focused) => focused === false,
  );
  return nextStatus(popup.page, () => popup.page.locator("#btn-fill").click());
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
 *
 * The start is asked for over DevTools: the two events that would wake the
 * worker in a browser, a menu click and the shortcut, need a real gesture.
 */
export async function restartWorker(extension, page) {
  const session = await extension.context.newCDPSession(page);
  try {
    const statuses = [];
    session.on("ServiceWorker.workerVersionUpdated", (event) => {
      for (const version of event.versions) statuses.push(version.runningStatus);
    });
    const reached = (status) =>
      until(
        `the worker to be ${status}`,
        () => statuses,
        (seen) => seen.at(-1) === status,
      );
    await session.send("ServiceWorker.enable");
    await session.send("ServiceWorker.stopAllWorkers");
    await reached("stopped");
    await session.send("ServiceWorker.startWorker", {
      scopeURL: `chrome-extension://${extension.id}/`,
    });
    await reached("running");
  } finally {
    await session.detach().catch(() => {});
  }
  // Playwright keeps its object for the worker and has to have found the
  // new global scope behind it before a test talks to it.
  await until("the restarted worker to answer", () =>
    extension
      .worker()
      .evaluate(() => true)
      .catch(() => false),
  );
}
