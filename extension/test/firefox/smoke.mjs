#!/usr/bin/env node
// Smoke test for the Firefox build: installs it as a temporary add-on in
// headless Firefox, opens the popup page and checks that the WASM core
// loads there and generates values.
//
//   node test/firefox/smoke.mjs dist/firefox
//
// Everything else that is tested runs in Chromium. This covers what only
// Firefox can answer: whether its manifest is accepted, whether the
// module scripts and the WASM core load under the extension CSP, and
// whether the popup comes up.
//
// It has no dependencies. It talks to geckodriver over the plain WebDriver
// HTTP protocol, and GitHub's ubuntu runners come with both Firefox and
// geckodriver. Environment:
//   GECKODRIVER     path to the geckodriver binary (default: the one in
//                   $GECKOWEBDRIVER, as set on GitHub runners, then PATH)
//   FIREFOX_BINARY  path to the Firefox binary (default: geckodriver's choice)
//
// This script was written where no Firefox was available. So far it has
// only been run against a stand-in for geckodriver that showed the popup in
// Chromium. Until it has passed in CI, a failure can be a defect of the
// test rather than of the extension.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";

// Firefox gives every extension a random internal UUID, and the address of
// its pages is moz-extension://<that UUID>/. Preloading the id-to-UUID map
// through a preference makes the address known in advance.
const UUID = "3f1b6a52-8c0d-4e7a-9b24-6d5e0a17c8f3";
const UUID_MAP_PREF = "extensions.webextensions.uuids";

// The key under which WebDriver returns an element reference.
const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";

const DEFAULT_PASSWORD_LENGTH = 20;

/** A failed check or a broken setup. Ends the test; printed without a stack trace. */
class SmokeError extends Error {}

/** A WebDriver command that failed. poll() retries these; elsewhere they end the test. */
class WebDriverError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => console.log(`[smoke] ${message}`);

function readBuild(argument) {
  if (!argument) throw new SmokeError("usage: node test/firefox/smoke.mjs <path to dist/firefox>");
  const dir = path.resolve(argument);
  const manifestFile = path.join(dir, "manifest.json");
  if (!existsSync(manifestFile)) {
    throw new SmokeError(`${manifestFile} does not exist. Run \`npm run build\` first.`);
  }
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  const id = manifest.browser_specific_settings?.gecko?.id;
  const popup = manifest.action?.default_popup;
  if (typeof id !== "string" || typeof popup !== "string") {
    throw new SmokeError(
      `${dir} is not the Firefox build: its manifest lacks browser_specific_settings.gecko.id or action.default_popup`,
    );
  }
  return { dir, id, popup };
}

// Asks the kernel for an unused port and releases it again. Another process
// could take it before geckodriver binds it; that would show up as
// geckodriver exiting at once, which is reported.
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function geckodriverCommand() {
  if (process.env.GECKODRIVER) return process.env.GECKODRIVER;
  const bundled = path.join(process.env.GECKOWEBDRIVER ?? "", "geckodriver");
  return process.env.GECKOWEBDRIVER && existsSync(bundled) ? bundled : "geckodriver";
}

function startDriver(port) {
  const command = geckodriverCommand();
  const child = spawn(command, ["--host", "127.0.0.1", "--port", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group: Firefox is started by geckodriver and stays in
    // that group, so both can be killed together if the session is stuck.
    detached: process.platform !== "win32",
  });
  const driver = { command, child, output: [], gone: null, exited: null };
  const keep = (chunk) => {
    driver.output.push(
      ...String(chunk)
        .split("\n")
        .filter((line) => line.trim() !== ""),
    );
    driver.output.splice(0, Math.max(0, driver.output.length - 40));
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  driver.exited = new Promise((resolve) => {
    child.once("error", (error) => resolve(`could not be started: ${error.message}`));
    child.once("exit", (code, signal) => resolve(`exited (${signal ?? `status ${code}`})`));
  }).then((how) => {
    driver.gone = how;
  });
  return driver;
}

async function stopDriver(driver) {
  if (!driver.gone) {
    driver.child.kill("SIGTERM");
    await Promise.race([driver.exited, sleep(5000)]);
  }
  // Deleting the session closes Firefox. If that did not happen, Firefox
  // is still running in geckodriver's process group.
  if (process.platform !== "win32" && driver.child.pid) {
    try {
      process.kill(-driver.child.pid, "SIGKILL");
    } catch {
      // The group is already gone.
    }
  } else if (!driver.gone) {
    driver.child.kill("SIGKILL");
  }
}

/** Returns a function that sends one WebDriver command and unwraps its value. */
function webdriver(base) {
  return async function call(method, route, body, timeoutMs = 30_000) {
    let response;
    try {
      response = await fetch(base + route, {
        method,
        // geckodriver rejects a POST without a JSON body, even an empty one.
        headers:
          body === undefined ? undefined : { "content-type": "application/json; charset=utf-8" },
        body: body === undefined ? undefined : JSON.stringify(body),
        // A hung browser must fail the test, not hold the job until its timeout.
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new WebDriverError(`${method} ${route}: ${error.cause?.message || error.message}`);
    }
    const text = await response.text();
    let value;
    try {
      value = JSON.parse(text).value;
    } catch {
      throw new WebDriverError(
        `${method} ${route}: HTTP ${response.status}, not JSON: ${text.slice(0, 200)}`,
      );
    }
    if (!response.ok) {
      const detail = value?.message ?? text.slice(0, 200);
      throw new WebDriverError(
        `${method} ${route}: ${value?.error ?? `HTTP ${response.status}`}: ${detail}`,
      );
    }
    return value;
  };
}

async function waitForDriver(driver, call) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (driver.gone) throw new SmokeError(`geckodriver (${driver.command}) ${driver.gone}`);
    try {
      if ((await call("GET", "/status", undefined, 2000))?.ready) return;
    } catch {
      // Not listening yet.
    }
    if (Date.now() >= deadline) {
      throw new SmokeError("geckodriver did not become ready within 15 s");
    }
    await sleep(100);
  }
}

/** The commands the test needs, bound to one session. Elements are addressed by CSS selector. */
function pageCommands(call, sessionId) {
  const at = (route) => `/session/${sessionId}${route}`;
  const find = async (css) =>
    (await call("POST", at("/element"), { using: "css selector", value: css }))[ELEMENT_KEY];
  return {
    installAddon: (dir) =>
      call("POST", at("/moz/addon/install"), { path: dir, temporary: true }, 60_000),
    navigate: (url) => call("POST", at("/url"), { url }, 60_000),
    attribute: async (css, name) =>
      call("GET", at(`/element/${await find(css)}/attribute/${name}`)),
    property: async (css, name) => call("GET", at(`/element/${await find(css)}/property/${name}`)),
    click: async (css) => call("POST", at(`/element/${await find(css)}/click`), {}),
    url: () => call("GET", at("/url")),
    title: () => call("GET", at("/title")),
    quit: () => call("DELETE", `/session/${sessionId}`, undefined, 20_000),
  };
}

/**
 * Calls probe until it returns true. Any other return value describes what
 * is still missing and ends up in the timeout message. A failed WebDriver
 * command is treated the same way: while a document loads, an element may
 * not exist yet.
 */
async function poll(what, timeoutMs, probe) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let state;
    try {
      state = await probe();
    } catch (error) {
      if (!(error instanceof WebDriverError)) throw error;
      state = error.message;
    }
    if (state === true) return;
    if (Date.now() >= deadline) {
      throw new SmokeError(`timed out after ${timeoutMs / 1000} s waiting for ${what}: ${state}`);
    }
    await sleep(100);
  }
}

// The popup shows core errors in #error and toggles it with the hidden
// attribute. Its text is the core's message and never a generated value.
async function failOnPopupError(page) {
  if ((await page.property("#error", "hidden")) === true) return;
  throw new SmokeError(`the popup shows an error: ${await page.property("#error", "textContent")}`);
}

// Generated values are compared and measured, never printed: CI logs are
// kept, and a habit of logging credentials should not start in a test.
async function checkPopup(page, popupUrl) {
  await page.navigate(popupUrl);

  // popup.ts sets data-ready on <body> once its first render and generation
  // attempt are over, also when start-up failed, so the checks below run
  // either way and say what went wrong.
  await poll("the popup to finish its first render", 30_000, async () =>
    (await page.attribute("body", "data-ready")) === "true"
      ? true
      : '<body> has no data-ready="true"',
  );
  await failOnPopupError(page);
  const password = await page.property("#output", "textContent");
  const length = Array.from(String(password ?? "")).length;
  if (length !== DEFAULT_PASSWORD_LENGTH) {
    throw new SmokeError(
      `expected a ${DEFAULT_PASSWORD_LENGTH}-character password in #output, found ${length} characters`,
    );
  }
  log(`ok: the popup is ready and shows a ${length}-character password`);

  // Switching tabs regenerates asynchronously, so the old value stays on
  // screen for a moment. The default passphrase joins its words with "-",
  // which the default password charset does not contain.
  await page.click("#tab-passphrase");
  await poll("the Passphrase tab to show a new value", 15_000, async () => {
    await failOnPopupError(page);
    const value = String((await page.property("#output", "textContent")) ?? "");
    if (value === password) return "#output still shows the password";
    return value.includes("-") ? true : `#output has ${value.length} characters and no "-"`;
  });
  log('ok: the Passphrase tab shows a new value that contains "-"');
}

async function main() {
  const build = readBuild(process.argv[2]);
  const port = await freePort();
  const driver = startDriver(port);
  const call = webdriver(`http://127.0.0.1:${port}`);
  let page;
  try {
    await waitForDriver(driver, call);
    const session = await call(
      "POST",
      "/session",
      {
        capabilities: {
          alwaysMatch: {
            browserName: "firefox",
            "moz:firefoxOptions": {
              args: ["-headless"],
              prefs: { [UUID_MAP_PREF]: JSON.stringify({ [build.id]: UUID }) },
              ...(process.env.FIREFOX_BINARY ? { binary: process.env.FIREFOX_BINARY } : {}),
            },
          },
        },
      },
      // Includes starting Firefox with a new profile.
      90_000,
    );
    page = pageCommands(call, session.sessionId);
    const versions = session.capabilities ?? {};
    log(`Firefox ${versions.browserVersion}, geckodriver ${versions["moz:geckodriverVersion"]}`);

    // A temporary add-on needs no signature and is installed from the
    // unpacked directory, the way about:debugging loads it.
    const installed = await page.installAddon(build.dir);
    if (installed !== build.id) {
      throw new SmokeError(
        `Firefox installed the add-on as "${installed}", expected "${build.id}"`,
      );
    }
    log(`installed ${installed} from ${build.dir}`);

    try {
      await checkPopup(page, `moz-extension://${UUID}/${build.popup}`);
    } catch (error) {
      // Tells a popup that misbehaves from one that never loaded.
      const where = await Promise.all([page.url(), page.title()]).then(
        ([url, title]) => ` (page: ${url}, title: ${JSON.stringify(title)})`,
        () => "",
      );
      error.message += where;
      throw error;
    }
  } catch (error) {
    if (driver.output.length > 0) {
      console.error(`[smoke] last geckodriver output:\n${driver.output.join("\n")}`);
    }
    throw error;
  } finally {
    if (page) await page.quit().catch(() => {});
    await stopDriver(driver);
  }
}

// process.exit rather than a natural exit: a socket or pipe left open by a
// half-dead browser would otherwise keep this process, and the CI step,
// alive after the verdict is known.
main().then(
  () => {
    log("PASS");
    process.exit(0);
  },
  (error) => {
    // Anything else is a defect of this script, where the stack is the useful part.
    const expected = error instanceof SmokeError || error instanceof WebDriverError;
    console.error(`[smoke] FAILED: ${expected ? error.message : error.stack}`);
    process.exit(1);
  },
);
