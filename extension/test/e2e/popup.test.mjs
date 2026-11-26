// The popup page of the real build, opened as a tab: generation on every
// tab, the options, the PIN gate, the Check tab, Copy, and what the page
// stores and logs.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  COMMAND,
  launchExtension,
  openPopup,
  serveFixtures,
  sleep,
  storageOf,
  tabOf,
} from "./helpers.mjs";

const TIMEOUT = { timeout: 60_000 };

// The ids that spec'd behaviour, these tests and test/firefox/smoke.mjs
// address. Renaming one breaks the Firefox smoke test, which only CI runs.
const MARKUP_CONTRACT = [
  "notice",
  "tab-password",
  "tab-passphrase",
  "tab-secret",
  "tab-apiKey",
  "tab-pin",
  "tab-entropy",
  "panel-password",
  "panel-passphrase",
  "panel-secret",
  "panel-apiKey",
  "panel-pin",
  "panel-entropy",
  "output",
  "entropy-bits",
  "crack-time",
  "warnings",
  "error",
  "btn-generate",
  "btn-copy",
  "btn-fill",
  "status",
  "pw-length",
  "pw-charset",
  "pin-ack",
  "check-input",
  "check-result",
  "shortcut",
  "version",
];

const text = (page, selector) => page.locator(selector).textContent();
const output = (page) => text(page, "#output");

/**
 * Polls #output until `predicate` accepts it and returns the value. The
 * polling runs here, not in the page: the extension's CSP allows no code
 * that is built from a string there.
 */
async function waitForOutput(page, predicate) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await output(page);
    if (predicate(value)) return value;
    assert.ok(Date.now() < deadline, `#output (${value.length} characters) is not as expected`);
    await sleep(25);
  }
}

/** Selects a tab and waits until the value on display has been replaced. */
async function selectTab(page, tab) {
  const before = await output(page);
  await page.locator(`#tab-${tab}`).click();
  return waitForOutput(page, (value) => value !== "" && value !== before);
}

describe("the popup", () => {
  let extension;
  let popup;
  let page;

  before(async () => {
    extension = await launchExtension();
    await extension.context.grantPermissions(["clipboard-read", "clipboard-write"]);
    popup = await openPopup(extension);
    page = popup.page;
  });

  after(async () => {
    await extension?.close();
  });

  test("the service worker has its listeners and no messaging surface", TIMEOUT, async () => {
    const worker = extension.worker();
    // A worker that threw while loading can still be registered, so the
    // listeners are what shows that background.js ran to its end.
    const listeners = await worker.evaluate(() => ({
      installed: chrome.runtime.onInstalled.hasListeners(),
      startup: chrome.runtime.onStartup.hasListeners(),
      menu: chrome.contextMenus.onClicked.hasListeners(),
      command: chrome.commands.onCommand.hasListeners(),
      message: chrome.runtime.onMessage.hasListeners(),
      messageExternal: chrome.runtime.onMessageExternal.hasListeners(),
      connect: chrome.runtime.onConnect.hasListeners(),
    }));
    assert.deepEqual(listeners, {
      installed: true,
      startup: true,
      menu: true,
      command: true,
      message: false,
      messageExternal: false,
      connect: false,
    });
    const commands = await worker.evaluate(() => chrome.commands.getAll());
    assert.deepEqual(
      commands.filter((command) => command.name === COMMAND).map((command) => command.shortcut),
      ["Alt+Shift+G"],
    );
  });

  test("opens with a password, its facts and the documented elements", TIMEOUT, async () => {
    const missing = await page.evaluate(
      (ids) => ids.filter((id) => !document.getElementById(id)),
      MARKUP_CONTRACT,
    );
    assert.deepEqual(missing, []);
    assert.equal(await page.locator("html").getAttribute("lang"), "en");
    assert.equal(await text(page, "#version"), extension.manifest.version);
    assert.equal(await text(page, "#shortcut"), "Alt+Shift+G");
    assert.equal(await page.locator("#tab-password").getAttribute("aria-selected"), "true");
    assert.equal(await page.locator("#panel-password").isVisible(), true);

    const value = await output(page);
    assert.match(value, /^[A-Za-z0-9]{20}$/);
    // The default settings require all three.
    assert.match(value, /[a-z]/);
    assert.match(value, /[A-Z]/);
    assert.match(value, /[0-9]/);
    assert.equal(await text(page, "#entropy-bits"), extension.message("popupEntropy", "119.1"));
    assert.equal(await text(page, "#length"), extension.message("popupLengthMany", "20"));
    assert.notEqual((await text(page, "#crack-time")).trim(), "");
    assert.equal(await page.locator("#crack-list dt").count(), 5);
    assert.equal(await page.locator("#crack-list dd").count(), 5);
    for (const hidden of ["#notice", "#error", "#warnings"]) {
      assert.equal(await page.locator(hidden).isHidden(), true, hidden);
    }

    assert.equal(await page.locator("#btn-copy").isEnabled(), true);
    // Opened as a tab of its own, the popup has no page to fill.
    assert.equal(await page.locator("#btn-fill").isDisabled(), true);
    assert.equal(await text(page, "#fill-hint"), extension.message("popupFillUnavailable"));
    assert.deepEqual(await popup.problems(), []);
  });

  test("every generator tab produces a value of its kind", TIMEOUT, async () => {
    const passphrase = await selectTab(page, "passphrase");
    assert.match(passphrase, /^[a-z]+(-[a-z]+){7}$/);
    assert.equal(await page.locator("#panel-passphrase").isVisible(), true);
    assert.equal(await page.locator("#panel-password").isHidden(), true);

    // 32 random bytes as base64url without padding.
    assert.match(await selectTab(page, "secret"), /^[A-Za-z0-9_-]{43}$/);
    assert.match(await selectTab(page, "apiKey"), /^sk_[A-Za-z0-9]{32}$/);
    assert.match(await selectTab(page, "password"), /^[A-Za-z0-9]{20}$/);
    assert.deepEqual(await popup.problems(), []);
  });

  test("Regenerate replaces the value and Copy puts it on the clipboard", TIMEOUT, async () => {
    const first = await output(page);
    await page.locator("#btn-generate").click();
    const value = await waitForOutput(page, (value) => value !== "" && value !== first);
    assert.match(value, /^[A-Za-z0-9]{20}$/);

    await page.locator("#btn-copy").click();
    await page.waitForSelector("#status[data-state]");
    assert.equal(await text(page, "#status"), extension.message("popupCopied"));
    assert.equal(await page.locator("#status").getAttribute("data-state"), "ok");
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), value);
    await page.evaluate(() => navigator.clipboard.writeText(""));
    assert.deepEqual(await popup.problems(), []);
  });

  test("a PIN is generated only after its low entropy was acknowledged", TIMEOUT, async () => {
    await page.locator("#tab-pin").click();
    await page.waitForSelector("#hint:not([hidden])");
    assert.equal(await text(page, "#hint"), extension.message("popupPinHint"));
    assert.equal(await output(page), "");
    assert.equal(await page.locator("#error").isHidden(), true, "the gate is not an error");
    for (const button of ["#btn-generate", "#btn-copy"]) {
      assert.equal(await page.locator(button).isDisabled(), true, button);
    }

    await page.locator("#pin-ack").check();
    await waitForOutput(page, (value) => value !== "");
    assert.match(await output(page), /^[0-9]{6}$/);
    assert.ok((await page.locator("#warnings li").count()) >= 1, "the core warns about PINs");

    await page.locator("#pin-ack").uncheck();
    await waitForOutput(page, (value) => value === "");
    assert.equal(await page.locator("#hint").isVisible(), true);
    assert.deepEqual(await popup.problems(), []);
  });

  test("the Check tab estimates a typed password without keeping it", TIMEOUT, async () => {
    const typed = "correct horse battery staple 42";
    await page.locator("#tab-entropy").click();
    assert.equal(await page.locator("#result").isHidden(), true, "no Copy or Fill on this tab");
    assert.equal(await page.locator("#check-hint").isVisible(), true);
    assert.equal(await page.locator("#check-error").isHidden(), true);

    const input = page.locator("#check-input");
    assert.equal(await input.getAttribute("type"), "password");
    assert.equal(await input.getAttribute("autocomplete"), "off");
    assert.equal(await input.getAttribute("spellcheck"), "false");
    await input.fill(typed);
    await page.waitForSelector("#check-details:not([hidden])");
    assert.match(await text(page, "#check-bits"), /^\d+\.\d bits of entropy$/);
    assert.equal(
      await text(page, "#check-length"),
      extension.message("popupLengthMany", String(typed.length)),
    );
    assert.notEqual((await text(page, "#check-crack-time")).trim(), "");
    assert.equal(await page.locator("#check-crack-list dt").count(), 5);

    await page.locator("#check-toggle").click();
    assert.equal(await input.getAttribute("type"), "text");
    await page.locator("#check-toggle").click();
    assert.equal(await input.getAttribute("type"), "password");

    await input.fill("");
    await page.waitForSelector("#check-hint:not([hidden])");
    assert.equal(await page.locator("#check-details").isHidden(), true);

    await input.fill(typed);
    await page.waitForSelector("#check-details:not([hidden])");
    const kept = JSON.stringify([await storageOf(extension), page.url(), await page.title()]);
    assert.equal(kept.includes(typed), false, "the typed password must stay in the input");
    await input.fill("");
    assert.deepEqual(await popup.problems(), []);
  });

  test("arrow keys, Home and End move between the tabs", TIMEOUT, async () => {
    const selected = () =>
      page.evaluate(() => {
        const tabs = [...document.querySelectorAll('[role="tab"]')];
        return {
          selected: tabs
            .filter((tab) => tab.getAttribute("aria-selected") === "true")
            .map((tab) => tab.id),
          tabbable: tabs.filter((tab) => tab.tabIndex === 0).map((tab) => tab.id),
          focused: document.activeElement?.id,
        };
      });
    const only = (id) => ({ selected: [id], tabbable: [id], focused: id });

    await page.locator("#tab-entropy").focus();
    await page.keyboard.press("Home");
    assert.deepEqual(await selected(), only("tab-password"));
    await page.keyboard.press("ArrowRight");
    assert.deepEqual(await selected(), only("tab-passphrase"));
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    assert.deepEqual(await selected(), only("tab-entropy"), "ArrowLeft wraps around");
    await page.keyboard.press("ArrowRight");
    assert.deepEqual(await selected(), only("tab-password"), "ArrowRight wraps around");
    await page.keyboard.press("End");
    assert.deepEqual(await selected(), only("tab-entropy"));
    assert.equal(await page.locator("#panel-entropy").isVisible(), true);
    await page.keyboard.press("Home");
    assert.deepEqual(await popup.problems(), []);
  });

  test(
    "a setting the core refuses shows its reason and leaves nothing to copy",
    TIMEOUT,
    async () => {
      await page.locator("#tab-password").click();
      await page.locator("#pw-length").fill("8");
      await page.waitForSelector("#error:not([hidden])");
      assert.match(await text(page, "#error"), /entropy/i);
      assert.equal(await page.locator("#error").getAttribute("role"), "alert");
      assert.equal(await output(page), "", "a refused setting must not leave the old value");
      assert.equal(await page.locator("#btn-copy").isDisabled(), true);

      await page.locator("#pw-allow-weak").check();
      await waitForOutput(page, (value) => value.length === 8);
      assert.equal(await page.locator("#error").isHidden(), true);
      assert.ok((await page.locator("#warnings li").count()) >= 1, "the core flags the weak value");

      await page.locator("#pw-allow-weak").uncheck();
      await page.waitForSelector("#error:not([hidden])");
      await page.locator("#pw-length").fill("20");
      await waitForOutput(page, (value) => value.length === 20);
      assert.deepEqual(await popup.problems(), []);
    },
  );

  test("options are clamped, saved and restored, and nothing else is stored", TIMEOUT, async () => {
    await page.locator("#pw-length").fill("99999");
    await waitForOutput(page, (value) => value.length === 256);
    assert.equal(await page.locator("#pw-length").inputValue(), "256", "clamped to the maximum");
    assert.equal(await page.locator("#pw-length-range").inputValue(), "256");

    await page.locator("#pw-length").fill("32");
    await waitForOutput(page, (value) => value.length === 32);
    await page.locator("#pw-charset").selectOption("alphanum-symbols-v1");
    await page.locator("#pw-class-symbol").check();
    await waitForOutput(page, (value) => value.length === 32 && /[^A-Za-z0-9]/.test(value));
    await page.locator("#tab-passphrase").click();
    await page.locator("#pp-words").fill("9");
    await page.locator("#pp-separator").fill(".");
    await waitForOutput(page, (value) => value.split(".").length === 9);

    await page.reload();
    await page.waitForFunction(() => document.body.dataset.ready === "true");
    assert.equal(await page.locator("#tab-passphrase").getAttribute("aria-selected"), "true");
    assert.equal(await page.locator("#pp-words").inputValue(), "9");
    assert.equal(await page.locator("#pp-separator").inputValue(), ".");
    assert.equal((await output(page)).split(".").length, 9);
    assert.equal(await page.locator("#pw-length").inputValue(), "32");
    assert.equal(await page.locator("#pw-charset").inputValue(), "alphanum-symbols-v1");
    assert.equal(await page.locator("#pw-class-symbol").isChecked(), true);

    const shown = await output(page);
    const storage = await storageOf(extension);
    assert.deepEqual(Object.keys(storage.local), ["settings.v1"]);
    assert.deepEqual(Object.keys(storage.session), []);
    const saved = storage.local["settings.v1"];
    assert.equal(saved.tab, "passphrase");
    assert.deepEqual(saved.password, {
      length: 32,
      charsetId: "alphanum-symbols-v1",
      exclude: "",
      requiredClasses: ["lower", "upper", "digit", "symbol"],
      allowWeak: false,
    });
    assert.deepEqual(saved.passphrase, {
      words: 9,
      separator: ".",
      capitalize: false,
      digitSuffix: false,
    });
    assert.equal(JSON.stringify(storage).includes(shown), false, "the value must not be stored");
    assert.deepEqual(await popup.problems(), []);
  });

  // The same call succeeds in fill.test.mjs, where the browser has granted
  // activeTab for the page first.
  test("Fill reports a page the browser keeps the extension out of", TIMEOUT, async () => {
    const fixtures = await serveFixtures({
      "/": '<!doctype html><title>Sign up</title><form><input id="pw" type="password"></form>',
    });
    const fixture = await extension.context.newPage();
    try {
      await fixture.goto(`${fixtures.origin}/`);
      await fixture.focus("#pw");
      const tab = await tabOf(extension, fixture);
      const pointed = await openPopup(extension, `?tabId=${tab.id}`);
      assert.equal(await pointed.page.locator("#btn-fill").isEnabled(), true);
      await pointed.page.locator("#btn-fill").click();
      await pointed.page.waitForSelector("#status[data-state]");
      assert.equal(await pointed.page.locator("#status").getAttribute("data-state"), "bad");
      assert.equal(await text(pointed.page, "#status"), extension.message("fillBlocked"));
      assert.equal(await fixture.inputValue("#pw"), "");
      assert.deepEqual(await pointed.problems(), []);
      await pointed.page.close();
    } finally {
      await fixture.close();
      await fixtures.close();
    }
  });
});

describe("the popup in another UI language", () => {
  const openIn = async (language, check) => {
    const extension = await launchExtension({ language });
    try {
      const popup = await openPopup(extension);
      await check(extension, popup.page);
      assert.deepEqual(await popup.problems(), []);
    } finally {
      await extension.close();
    }
  };

  test("Brazilian Portuguese has its own text and number format", TIMEOUT, async () => {
    await openIn("pt-BR", async (extension, page) => {
      assert.equal(await page.locator("html").getAttribute("lang"), "pt-BR");
      assert.equal(await text(page, "#tab-password"), "Senha");
      assert.equal(await text(page, "#entropy-bits"), "119,1 bits de entropia");
      assert.equal(await text(page, "#btn-copy"), extension.message("popupCopy"));
      // No label is cut off and the six tabs still share one row.
      const layout = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        rows: new Set([...document.querySelectorAll('[role="tab"]')].map((tab) => tab.offsetTop))
          .size,
      }));
      assert.deepEqual(layout, { overflow: false, rows: 1 });
    });
  });

  // German has no locale folder: the text falls back to English, and the
  // lang attribute and the number format have to follow the text.
  test("a language without a translation falls back to English as a whole", TIMEOUT, async () => {
    await openIn("de", async (_extension, page) => {
      assert.equal(await page.evaluate(() => chrome.i18n.getUILanguage()), "de");
      assert.equal(await page.locator("html").getAttribute("lang"), "en");
      assert.equal(await text(page, "#tab-password"), "Password");
      assert.equal(await text(page, "#entropy-bits"), "119.1 bits of entropy");
    });
  });
});
