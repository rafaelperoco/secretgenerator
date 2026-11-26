// The popup page of the real build, opened as a tab: generation on every
// tab, the options, the PIN gate, the Check tab, Copy, the keyboard, and
// what the page stores and logs.
//
// Every test opens its own popup on the default settings. What a popup
// printed, threw or was refused by its CSP is checked after each test.
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { launchExtension, nextStatus, until } from "./helpers.mjs";

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

describe("the popup", () => {
  let extension;
  // Every value a popup showed and everything typed on the Check tab.
  // None of it may turn up in storage.
  const secrets = new Set();
  // How many notices the notice test put into storage.session by hand.
  // The last test must find no other write outside the options.
  let noticesLeft = 0;

  const output = async (page) => {
    const value = await text(page, "#output");
    if (value !== "") secrets.add(value);
    return value;
  };

  /** Waits until #output satisfies `accept` and returns the value. */
  const outputThat = (page, what, accept) =>
    until(`#output to be ${what}`, () => output(page), accept);

  /** Selects a tab and returns the value generated for it. */
  async function selectTab(page, tab) {
    const before = await output(page);
    await page.locator(`#tab-${tab}`).click();
    return outputThat(page, `a new value on the ${tab} tab`, (v) => v !== "" && v !== before);
  }

  /** The facts shown next to the value on display. */
  const facts = (page) =>
    page.evaluate(() => ({
      bits: document.getElementById("entropy-bits").textContent,
      length: document.getElementById("length").textContent,
      crackTime: document.getElementById("crack-time").textContent.trim(),
      profiles: document.querySelectorAll("#crack-list dt").length,
      times: [...document.querySelectorAll("#crack-list dd")].map((dd) => dd.textContent.trim()),
    }));

  /** Asserts that the facts on display describe `value`. */
  async function assertFacts(page, value, minimumBits) {
    const shown = await facts(page);
    const bits = /^(\d+\.\d) bits of entropy$/.exec(shown.bits);
    assert.ok(bits, `entropy line: "${shown.bits}"`);
    assert.ok(Number(bits[1]) >= minimumBits, `${bits[1]} bits, expected at least ${minimumBits}`);
    assert.equal(shown.length, extension.message("popupLengthMany", String(value.length)));
    assert.notEqual(shown.crackTime, "");
    assert.equal(shown.profiles, 5, "one line per attacker profile");
    assert.equal(shown.times.filter((time) => time !== "").length, 5);
    // The headline is the strongest attacker, the last profile.
    assert.equal(shown.crackTime, shown.times.at(-1));
  }

  before(async () => {
    extension = await launchExtension();
    // Reading the clipboard back needs a permission; writing to it from a
    // click must work without one, as it has to for a user.
    await extension.context.grantPermissions(["clipboard-read"]);
  });

  beforeEach(async () => {
    await extension.worker().evaluate(() => chrome.storage.local.clear());
  });

  afterEach(async () => {
    assert.deepEqual(await extension.endTest(), [], "the popup logged or was refused something");
  });

  after(async () => {
    await extension?.close();
  });

  test("opens ready, with a password, its facts and the documented elements", TIMEOUT, async () => {
    const { page } = await extension.openPopup();
    assert.equal(await page.locator("body").getAttribute("data-ready"), "true");
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
    await assertFacts(page, value, 119);
    for (const hidden of ["#notice", "#error", "#warnings", "#hint"]) {
      assert.equal(await page.locator(hidden).isHidden(), true, hidden);
    }

    assert.equal(await page.locator("#btn-generate").isEnabled(), true);
    assert.equal(await page.locator("#btn-copy").isEnabled(), true);
    // Opened as a tab of its own, the popup has no page to fill.
    assert.equal(await page.locator("#btn-fill").isDisabled(), true);
    assert.equal(await text(page, "#fill-hint"), extension.message("popupFillUnavailable"));
    // Nothing identifies the value outside the box that shows it.
    assert.equal(await page.title(), "secretgenerator");
    assert.equal(page.url(), extension.popupUrl);
  });

  test("every tab produces a value of its kind", TIMEOUT, async () => {
    const { page } = await extension.openPopup();
    const panelsShown = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('[role="tabpanel"]')]
          .filter((panel) => !panel.hidden)
          .map((panel) => panel.id),
      );

    // Eight lowercase words joined by hyphens. Four words of the list
    // contain a hyphen themselves ("yo-yo"), hence the upper bound.
    const passphrase = await selectTab(page, "passphrase");
    assert.match(passphrase, /^[a-z]+(-[a-z]+){7,15}$/);
    assert.deepEqual(await panelsShown(), ["panel-passphrase"]);
    await assertFacts(page, passphrase, 80);

    // 32 random bytes as base64url without padding.
    const secret = await selectTab(page, "secret");
    assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(await panelsShown(), ["panel-secret"]);
    await assertFacts(page, secret, 256);

    // Prefix, separator, 32 random alphanumeric characters.
    const apiKey = await selectTab(page, "apiKey");
    assert.match(apiKey, /^sk_[A-Za-z0-9]{32}$/);
    assert.deepEqual(await panelsShown(), ["panel-apiKey"]);
    await assertFacts(page, apiKey, 190);

    // The PIN tab starts behind its gate; ticked, it gives six digits.
    await page.locator("#tab-pin").click();
    await page.locator("#pin-ack").check();
    const pin = await outputThat(page, "a PIN", (value) => /^[0-9]+$/.test(value));
    assert.match(pin, /^[0-9]{6}$/);
    assert.deepEqual(await panelsShown(), ["panel-pin"]);
    await assertFacts(page, pin, 19);

    const password = await selectTab(page, "password");
    assert.match(password, /^[A-Za-z0-9]{20}$/);
    assert.deepEqual(await panelsShown(), ["panel-password"]);

    // Five values of five kinds: none is a leftover of the tab before.
    assert.equal(new Set([passphrase, secret, apiKey, pin, password]).size, 5);
  });

  test("the options of each tab shape its value", TIMEOUT, async () => {
    const { page } = await extension.openPopup();

    await page.locator("#pw-length").fill("40");
    await page.locator("#pw-charset").selectOption("alphanum-symbols-v1");
    await page.locator("#pw-class-symbol").check();
    await page.locator("#pw-exclude").fill("aeiouAEIOU0");
    const password = await outputThat(
      page,
      "a 40-character password with a symbol",
      (value) => value.length === 40 && /[^A-Za-z0-9]/.test(value) && !/[aeiouAEIOU0]/.test(value),
    );
    assert.doesNotMatch(password, /\s/);
    for (const required of [/[a-z]/, /[A-Z]/, /[0-9]/]) assert.match(password, required);

    // A separator no word contains, so the words can be counted.
    await page.locator("#tab-passphrase").click();
    await page.locator("#pp-words").fill("7");
    await page.locator("#pp-separator").fill(".");
    await page.locator("#pp-capitalize").check();
    await page.locator("#pp-digit-suffix").check();
    await outputThat(page, "seven capitalized words and a digit", (value) =>
      /^([A-Z][a-z-]+\.){6}[A-Z][a-z-]+[0-9]$/.test(value),
    );
    assert.equal(
      await page.locator("#warnings li").count(),
      2,
      "one warning per compatibility flag",
    );

    await page.locator("#tab-secret").click();
    await page.locator("#sc-bytes").fill("16");
    await page.locator("#sc-encoding").selectOption("hex");
    await page.locator("#sc-prefix").fill("tok_");
    await outputThat(page, "16 bytes in hex after the prefix", (value) =>
      /^tok_[0-9a-f]{32}$/.test(value),
    );
    await page.locator("#sc-encoding").selectOption("base32");
    await outputThat(page, "16 bytes in base32 after the prefix", (value) =>
      /^tok_[A-Z2-7]{26}=*$/.test(value),
    );
    await page.locator("#sc-encoding").selectOption("base64");
    await outputThat(page, "16 bytes in base64 after the prefix", (value) =>
      /^tok_[A-Za-z0-9+/]{22}=*$/.test(value),
    );

    await page.locator("#tab-apiKey").click();
    await page.locator("#ak-prefix").fill("pk");
    await page.locator("#ak-separator").fill("-");
    await page.locator("#ak-length").fill("24");
    await outputThat(page, "a pk- key of 24 characters", (value) =>
      /^pk-[A-Za-z0-9]{24}$/.test(value),
    );

    await page.locator("#tab-pin").click();
    await page.locator("#pin-ack").check();
    await page.locator("#pin-digits").fill("8");
    await outputThat(page, "an 8-digit PIN", (value) => /^[0-9]{8}$/.test(value));
  });

  test("Regenerate replaces the value and Copy puts it on the clipboard", TIMEOUT, async () => {
    const { page } = await extension.openPopup();
    const first = await output(page);
    await page.locator("#btn-generate").click();
    const value = await outputThat(page, "a new password", (v) => v !== "" && v !== first);
    assert.match(value, /^[A-Za-z0-9]{20}$/);

    const status = await nextStatus(page, () => page.locator("#btn-copy").click());
    assert.deepEqual(status, { state: "ok", text: extension.message("popupCopied") });
    assert.equal(await page.locator("#status").getAttribute("aria-live"), "polite");
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), value);
    await page.evaluate(() => navigator.clipboard.writeText(""));

    // The status line empties itself after a few seconds.
    await until(
      "the status to clear",
      () => page.evaluate(() => document.getElementById("status").outerHTML),
      (html) => !html.includes("data-state") && html.endsWith("></p>"),
    );
  });

  test("Copy says so when the browser refuses the clipboard", TIMEOUT, async () => {
    const { page } = await extension.openPopup();
    await output(page);
    // The one thing here that is not the real browser: a clipboard that
    // refuses cannot be had on demand.
    await page.evaluate(() => {
      navigator.clipboard.writeText = () =>
        Promise.reject(new DOMException("denied", "NotAllowedError"));
    });
    const status = await nextStatus(page, () => page.locator("#btn-copy").click());
    assert.deepEqual(status, { state: "bad", text: extension.message("popupCopyFailed") });
  });

  test("a PIN is generated only after its low entropy was acknowledged", TIMEOUT, async () => {
    const { page } = await extension.openPopup();
    await page.locator("#tab-pin").click();
    await page.waitForSelector("#hint:not([hidden])");
    assert.equal(await text(page, "#hint"), extension.message("popupPinHint"));
    assert.equal(await output(page), "");
    assert.equal(await page.locator("#error").isHidden(), true, "the gate is not an error");
    assert.equal(await page.locator("#meta").isHidden(), true, "no facts without a value");
    for (const button of ["#btn-generate", "#btn-copy", "#btn-fill"]) {
      assert.equal(await page.locator(button).isDisabled(), true, button);
    }

    await page.locator("#pin-ack").check();
    const pin = await outputThat(page, "a PIN", (value) => value !== "");
    assert.match(pin, /^[0-9]{6}$/);
    assert.equal(await page.locator("#hint").isHidden(), true);
    assert.ok((await page.locator("#warnings li").count()) >= 1, "the core warns about PINs");
    assert.equal(await page.locator("#btn-copy").isEnabled(), true);

    await page.locator("#pin-ack").uncheck();
    await outputThat(page, "empty again", (value) => value === "");
    assert.equal(await page.locator("#hint").isVisible(), true);
    assert.equal(await page.locator("#btn-copy").isDisabled(), true);

    // The gate is per kind: the other tabs still generate behind it.
    assert.match(await selectTab(page, "password"), /^[A-Za-z0-9]{20}$/);
  });

  test("the Check tab estimates a typed password without keeping it", TIMEOUT, async () => {
    const typed = "correct horse battery staple 42";
    secrets.add(typed);
    const { page } = await extension.openPopup();
    await page.locator("#tab-entropy").click();
    assert.equal(await page.locator("#result").isHidden(), true, "no value box on this tab");
    for (const button of ["#btn-copy", "#btn-fill", "#btn-generate"]) {
      assert.equal(await page.locator(button).isHidden(), true, button);
    }
    assert.equal(await page.locator("#check-hint").isVisible(), true);
    assert.equal(await page.locator("#check-error").isHidden(), true);

    const input = page.locator("#check-input");
    assert.equal(await input.getAttribute("type"), "password");
    assert.equal(await input.getAttribute("autocomplete"), "off");
    assert.equal(await input.getAttribute("spellcheck"), "false");
    await input.pressSequentially(typed);
    await page.waitForSelector("#check-details:not([hidden])");
    // The estimate follows the typing, so wait for the one of the full text.
    await until(
      "the estimate of everything typed",
      () => text(page, "#check-length"),
      (shown) => shown === extension.message("popupLengthMany", String(typed.length)),
    );
    assert.match(await text(page, "#check-bits"), /^\d+\.\d bits of entropy$/);
    assert.equal(
      await text(page, "#check-classes"),
      extension.message("popupCheckClasses", "Lowercase, Digits, Symbols"),
    );
    assert.notEqual((await text(page, "#check-crack-time")).trim(), "");
    assert.equal(await page.locator("#check-crack-list dt").count(), 5);
    assert.equal(await page.locator("#check-hint").isHidden(), true);

    await page.locator("#check-toggle").click();
    assert.equal(await input.getAttribute("type"), "text");
    assert.equal(await text(page, "#check-toggle"), extension.message("popupCheckHide"));
    await page.locator("#check-toggle").click();
    assert.equal(await input.getAttribute("type"), "password");

    // Nothing of it outside the input: not in storage, the address or the title.
    const kept = JSON.stringify([
      await extension.storage(),
      await extension.storageChanges(),
      page.url(),
      await page.title(),
    ]);
    assert.equal(kept.includes(typed), false, "the typed password must stay in the input");

    await input.fill("");
    await page.waitForSelector("#check-hint:not([hidden])");
    assert.equal(await page.locator("#check-details").isHidden(), true);
    assert.equal(await page.locator("#check-error").isHidden(), true, "empty is not an error");

    // A reopened popup starts on the Check tab, which was saved, with an
    // empty input, which was not.
    await input.fill(typed);
    await page.waitForSelector("#check-details:not([hidden])");
    await page.reload();
    await page.waitForFunction(() => document.body.dataset.ready === "true");
    assert.equal(await page.locator("#tab-entropy").getAttribute("aria-selected"), "true");
    assert.equal(await input.inputValue(), "");
    assert.equal(await page.locator("#check-hint").isVisible(), true);
  });

  test("the tabs work from the keyboard", TIMEOUT, async () => {
    const { page } = await extension.openPopup();
    const state = () =>
      page.evaluate(() => {
        const tabs = [...document.querySelectorAll('[role="tab"]')];
        return {
          selected: tabs
            .filter((tab) => tab.getAttribute("aria-selected") === "true")
            .map((tab) => tab.id),
          tabbable: tabs.filter((tab) => tab.tabIndex === 0).map((tab) => tab.id),
          focused: document.activeElement?.id,
          panels: [...document.querySelectorAll('[role="tabpanel"]')]
            .filter((panel) => !panel.hidden)
            .map((panel) => panel.id),
        };
      });
    const on = (tab) => ({
      selected: [`tab-${tab}`],
      tabbable: [`tab-${tab}`],
      focused: `tab-${tab}`,
      panels: [`panel-${tab}`],
    });

    assert.equal(
      await page.locator('[role="tablist"]').getAttribute("aria-label"),
      "Credential type",
    );
    for (const tab of await page.locator('[role="tab"]').all()) {
      const panel = await tab.getAttribute("aria-controls");
      assert.equal(await page.locator(`#${panel}`).getAttribute("role"), "tabpanel");
      assert.equal(
        await page.locator(`#${panel}`).getAttribute("aria-labelledby"),
        await tab.getAttribute("id"),
      );
    }

    // The first Tab key lands on the selected tab.
    await page.keyboard.press("Tab");
    assert.deepEqual(await state(), on("password"));
    const password = await output(page);

    await page.keyboard.press("ArrowRight");
    assert.deepEqual(await state(), on("passphrase"));
    // Moving to a tab selects it and generates for it.
    await outputThat(page, "a passphrase", (value) => value.includes("-") && value !== password);

    await page.keyboard.press("ArrowLeft");
    assert.deepEqual(await state(), on("password"));
    await page.keyboard.press("ArrowLeft");
    assert.deepEqual(await state(), on("entropy"), "ArrowLeft wraps around");
    await page.keyboard.press("ArrowRight");
    assert.deepEqual(await state(), on("password"), "ArrowRight wraps around");
    await page.keyboard.press("End");
    assert.deepEqual(await state(), on("entropy"));
    await page.keyboard.press("Home");
    assert.deepEqual(await state(), on("password"));
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    assert.deepEqual(await state(), on("secret"));

    // Only the selected tab is a Tab stop: the next one is past the strip.
    await page.keyboard.press("Tab");
    assert.equal((await state()).focused, "output");
    await page.keyboard.press("Shift+Tab");
    assert.deepEqual(await state(), on("secret"));

    // The buttons answer the keyboard as well.
    const before = await outputThat(page, "a secret", (value) => /^[A-Za-z0-9_-]{43}$/.test(value));
    await page.locator("#btn-generate").focus();
    await page.keyboard.press("Enter");
    await outputThat(page, "another secret", (value) => value !== "" && value !== before);
  });

  test(
    "a setting the core refuses shows its reason and leaves nothing to copy",
    TIMEOUT,
    async () => {
      const { page } = await extension.openPopup();
      const stale = await output(page);
      await page.locator("#pw-length").fill("8");
      await page.waitForSelector("#error:not([hidden])");
      assert.match(await text(page, "#error"), /entropy/i);
      assert.equal(await page.locator("#error").getAttribute("role"), "alert");
      assert.equal(await output(page), "", "a refused setting must not leave the old value");
      assert.equal(await page.locator("#meta").isHidden(), true, "nor its facts");
      assert.equal(await page.locator("#btn-copy").isDisabled(), true);
      assert.equal(await page.locator("#btn-fill").isDisabled(), true);
      assert.equal(
        await page.locator("#btn-copy").getAttribute("title"),
        extension.message("popupNoValue"),
      );
      // Nothing was put on the clipboard on the way.
      await page.locator("#btn-copy").click({ force: true });
      assert.notEqual(await page.evaluate(() => navigator.clipboard.readText()), stale);

      // Regenerate asks the core again and gets the same answer.
      await page.locator("#btn-generate").click();
      await page.waitForSelector("#error:not([hidden])");
      assert.equal(await output(page), "");

      await page.locator("#pw-allow-weak").check();
      const weak = await outputThat(page, "an 8-character password", (value) => value.length === 8);
      assert.match(weak, /^[A-Za-z0-9]{8}$/);
      assert.equal(await page.locator("#error").isHidden(), true);
      assert.ok((await page.locator("#warnings li").count()) >= 1, "the core flags the weak value");

      await page.locator("#pw-allow-weak").uncheck();
      await page.waitForSelector("#error:not([hidden])");
      assert.equal(await output(page), "", "the weak value is gone with the permission for it");
      await page.locator("#pw-length").fill("20");
      await outputThat(page, "a 20-character password", (value) => value.length === 20);
      assert.equal(await page.locator("#error").isHidden(), true);
    },
  );

  test(
    "out-of-range options are clamped, in the form and in what is generated",
    TIMEOUT,
    async () => {
      const { page } = await extension.openPopup();
      await page.locator("#pw-length").fill("99999");
      const longest = await outputThat(page, "256 characters", (value) => value.length === 256);
      assert.match(longest, /^[A-Za-z0-9]{256}$/);
      assert.equal(await page.locator("#pw-length").inputValue(), "256", "clamped to the maximum");
      assert.equal(await page.locator("#pw-length-range").inputValue(), "256");

      // The slider and the number field are one option.
      await page.locator("#pw-length-range").fill("24");
      await outputThat(page, "24 characters", (value) => value.length === 24);
      assert.equal(await page.locator("#pw-length").inputValue(), "24");

      await page.locator("#tab-passphrase").click();
      await page.locator("#pp-separator").fill(".");
      await page.locator("#pp-words").fill("500");
      await outputThat(page, "32 words", (value) => value.split(".").length === 32);
      assert.equal(await page.locator("#pp-words").inputValue(), "32");

      // Below the minimum, the field is corrected when the edit is
      // committed: "1" may be the first digit of "16".
      await page.locator("#tab-pin").click();
      await page.locator("#pin-ack").check();
      await page.locator("#pin-digits").fill("1");
      assert.equal(await page.locator("#pin-digits").inputValue(), "1");
      await page.locator("#pin-digits").blur();
      await outputThat(page, "a 4-digit PIN", (value) => /^[0-9]{4}$/.test(value));
      assert.equal(await page.locator("#pin-digits").inputValue(), "4");

      const saved = (await extension.storage()).local["settings.v1"];
      assert.equal(saved.password.length, 24);
      assert.equal(saved.passphrase.words, 32);
      assert.equal(saved.pin.digits, 4);
    },
  );

  test("options are saved and restored when the popup opens again", TIMEOUT, async () => {
    const { page } = await extension.openPopup();
    await page.locator("#pw-length").fill("32");
    await page.locator("#pw-charset").selectOption("alphanum-symbols-v1");
    await page.locator("#pw-class-symbol").check();
    await outputThat(page, "32 characters with a symbol", (value) => {
      return value.length === 32 && /[^A-Za-z0-9]/.test(value);
    });
    await page.locator("#tab-passphrase").click();
    await page.locator("#pp-words").fill("9");
    await page.locator("#pp-separator").fill(".");
    await outputThat(page, "nine words", (value) => value.split(".").length === 9);

    await page.reload();
    await page.waitForFunction(() => document.body.dataset.ready === "true");
    assert.equal(await page.locator("#tab-passphrase").getAttribute("aria-selected"), "true");
    assert.equal(await page.locator("#pp-words").inputValue(), "9");
    assert.equal(await page.locator("#pp-separator").inputValue(), ".");
    assert.equal((await output(page)).split(".").length, 9);
    assert.equal(await page.locator("#pw-length").inputValue(), "32");
    assert.equal(await page.locator("#pw-length-range").inputValue(), "32");
    assert.equal(await page.locator("#pw-charset").inputValue(), "alphanum-symbols-v1");
    assert.equal(await page.locator("#pw-class-symbol").isChecked(), true);

    // A second popup reads the same settings: they are in storage, not in the page.
    const second = await extension.openPopup();
    assert.equal(
      await second.page.locator("#tab-passphrase").getAttribute("aria-selected"),
      "true",
    );
    assert.equal((await output(second.page)).split(".").length, 9);

    const { local } = await extension.storage();
    assert.deepEqual(Object.keys(local), ["settings.v1"]);
    assert.deepEqual(local["settings.v1"], {
      tab: "passphrase",
      password: {
        length: 32,
        charsetId: "alphanum-symbols-v1",
        exclude: "",
        requiredClasses: ["lower", "upper", "digit", "symbol"],
        allowWeak: false,
      },
      passphrase: { words: 9, separator: ".", capitalize: false, digitSuffix: false },
      secret: { bytes: 32, encoding: "base64url", prefix: "" },
      apiKey: { prefix: "sk", separator: "_", length: 32 },
      pin: { digits: 6, acknowledgeLowEntropy: false },
    });
  });

  test("fits a popup: 360 px wide, nothing sticks out, under 600 px high", TIMEOUT, async () => {
    const { page } = await extension.openPopup();
    // The browser sizes a popup to the body and cuts it off at 600 px.
    const measure = () =>
      page.evaluate(() => {
        const body = document.body.getBoundingClientRect();
        const sticksOut = [...document.querySelectorAll("body *")]
          .filter((element) => {
            const box = element.getBoundingClientRect();
            return box.width > 0 && (box.left < body.left - 0.5 || box.right > body.right + 0.5);
          })
          .map((element) => element.id || element.className || element.localName);
        return { width: body.width, height: body.height, sticksOut };
      });
    for (const tab of ["password", "passphrase", "secret", "apiKey", "pin", "entropy"]) {
      await page.locator(`#tab-${tab}`).click();
      if (tab === "pin") await page.locator("#pin-ack").check();
      if (tab === "entropy") await page.locator("#check-input").fill("a long enough password, 1!");
      else await outputThat(page, `a value on the ${tab} tab`, (value) => value !== "");
      const size = await measure();
      assert.equal(size.width, 360, tab);
      assert.deepEqual(size.sticksOut, [], tab);
      assert.ok(size.height <= 600, `${tab}: ${size.height} px high`);
      assert.equal(size.height, Math.round(size.height), `${tab}: a whole number of pixels`);
    }

    // The longest values wrap inside the box instead of widening it.
    await page.locator("#tab-password").click();
    await page.locator("#pw-length").fill("256");
    await outputThat(page, "256 characters", (value) => value.length === 256);
    assert.deepEqual((await measure()).sticksOut, []);
    await page.locator("#tab-secret").click();
    await page.locator("#sc-encoding").selectOption("hex");
    await page.locator("#sc-bytes").fill("1024");
    await outputThat(page, "2048 hex digits", (value) => value.length === 2048);
    const longest = await measure();
    assert.equal(longest.width, 360);
    assert.deepEqual(longest.sticksOut, []);
  });

  test(
    "a notice left by the background is shown once, a stale one not at all",
    TIMEOUT,
    async () => {
      // Written the way lib/notice.ts writes it after a failed shortcut. The
      // real sequence, with the real popup, is in action-popup.test.mjs.
      const leave = (at) => {
        noticesLeft++;
        return extension
          .worker()
          .evaluate(
            (at) =>
              chrome.storage.session.set({ "notice.v1": { message: "Left by the test.", at } }),
            at,
          );
      };
      await leave(Date.now());
      const first = await extension.openPopup();
      assert.equal(await first.page.locator("#notice").isVisible(), true);
      assert.equal(await text(first.page, "#notice"), "Left by the test.");
      assert.equal(await first.page.locator("#notice").getAttribute("role"), "status");
      assert.deepEqual(
        Object.keys((await extension.storage()).session),
        [],
        "taken out of storage",
      );
      const second = await extension.openPopup();
      assert.equal(await second.page.locator("#notice").isHidden(), true, "shown once");

      await leave(Date.now() - 5 * 60_000);
      const late = await extension.openPopup();
      assert.equal(await late.page.locator("#notice").isHidden(), true, "too old to mean anything");
      assert.deepEqual(Object.keys((await extension.storage()).session), [], "taken out as well");
    },
  );

  test("damaged or unknown stored options do not stop the popup", TIMEOUT, async () => {
    const store = (settings) =>
      extension
        .worker()
        .evaluate((settings) => chrome.storage.local.set({ "settings.v1": settings }), settings);

    // Wrong types everywhere: the core's bindings would not survive them.
    await store({
      tab: "nope",
      password: { length: "abc", charsetId: 5, requiredClasses: "x", exclude: 7, allowWeak: "yes" },
      passphrase: "x",
      secret: null,
      apiKey: [],
      pin: { digits: {}, acknowledgeLowEntropy: 1 },
    });
    const damaged = await extension.openPopup();
    assert.match(await output(damaged.page), /^[A-Za-z0-9]{20}$/, "the defaults apply");
    assert.equal(await damaged.page.locator("#tab-password").getAttribute("aria-selected"), "true");
    assert.equal(await damaged.page.locator("#error").isHidden(), true);

    await store("not even an object");
    const garbage = await extension.openPopup();
    assert.match(await output(garbage.page), /^[A-Za-z0-9]{20}$/);

    // A character set this core does not know, from a newer version, say.
    // The core says so; the popup shows that and keeps working.
    await store({ password: { charsetId: "klingon-v9" } });
    const { page } = await extension.openPopup();
    assert.equal(await output(page), "");
    assert.match(await text(page, "#error"), /klingon-v9/);
    assert.equal(
      await page.locator("#pw-charset").inputValue(),
      "klingon-v9",
      "not silently replaced",
    );
    assert.match(await selectTab(page, "passphrase"), /^[a-z]+(-[a-z]+){7,15}$/);
    await page.locator("#tab-password").click();
    await page.waitForSelector("#error:not([hidden])");
    await page.locator("#pw-charset").selectOption("alphanum-v1");
    assert.match(
      await outputThat(page, "a password again", (value) => value !== ""),
      /^[A-Za-z0-9]{20}$/,
    );
    assert.equal(await page.locator("#error").isHidden(), true);
  });

  test("a core that stopped is replaced, and the popup generates again", TIMEOUT, async () => {
    const popup = await extension.openPopup();
    const { page } = popup;
    const before = await output(page);
    // An option of the wrong type, which the popup never sends, is fatal
    // to the core: the Go program panics and exits, or the call traps,
    // depending on the compiler that built it.
    await page.evaluate(() => {
      try {
        globalThis.secretgen.password({ length: "twenty" });
      } catch {
        // The trap. The program is gone either way.
      }
    });

    // The first press may still meet the dead program and report it.
    const stopped = "The generator core stopped unexpectedly. Try again.";
    const shown = async () => ({
      value: await output(page),
      error: await text(page, "#error"),
    });
    await page.locator("#btn-generate").click();
    const first = await until(
      "a new value or the report of the stopped core",
      shown,
      (now) => (now.value !== "" && now.value !== before) || now.error !== "",
    );
    if (first.value === "") {
      assert.equal(first.error, stopped);
      await page.locator("#btn-generate").click();
    }
    const value = await outputThat(
      page,
      "a password from the new core",
      (v) => v !== "" && v !== before,
    );
    assert.match(value, /^[A-Za-z0-9]{20}$/);
    assert.equal(await page.locator("#error").isHidden(), true);

    // The panic was printed by the Go runtime's shim, and only that:
    // nothing was thrown past the popup's own code.
    const noise = await popup.problems();
    assert.ok(noise.length >= 1, "the shim reports the panic");
    assert.deepEqual(
      noise.filter((line) => !line.startsWith("console ")),
      [],
    );
    assert.match(noise[0], /panic: syscall\/js/);
    popup.forget();
  });

  test("an unassigned shortcut is shown as not set, with where to set it", TIMEOUT, async () => {
    // A suggested key that collides with another shortcut is left
    // unassigned by the browser. The same state is reached here through
    // the page behind chrome://extensions/shortcuts.
    const admin = await extension.context.newPage();
    const assign = (keybinding) =>
      admin.evaluate(
        ({ extensionId, keybinding }) =>
          new Promise((resolve, reject) => {
            chrome.developerPrivate.updateExtensionCommand(
              { extensionId, commandName: "fill-password", keybinding },
              () =>
                chrome.runtime.lastError
                  ? reject(new Error(chrome.runtime.lastError.message))
                  : resolve(),
            );
          }),
        { extensionId: extension.id, keybinding },
      );
    try {
      await admin.goto("chrome://extensions/shortcuts");
      await admin.waitForFunction(() => Boolean(chrome.developerPrivate), null, {
        timeout: 10_000,
      });
      await assign("");
      const { page } = await extension.openPopup();
      assert.equal(await text(page, "#shortcut"), extension.message("popupShortcutUnset"));
      assert.equal(await page.locator("#shortcut-hint").isVisible(), true);
      assert.equal(
        await text(page, "#shortcut-hint"),
        extension.message("popupShortcutHintChrome"),
      );
    } finally {
      await assign("Alt+Shift+G").catch(() => {});
      await admin.close();
    }
    const { page } = await extension.openPopup();
    assert.equal(await text(page, "#shortcut"), "Alt+Shift+G");
    assert.equal(await page.locator("#shortcut-hint").isHidden(), true);
  });

  // The same button fills a page in fill-popup.test.mjs, where the tests
  // have access to the page first.
  test("Fill reports a page the browser keeps the extension out of", TIMEOUT, async () => {
    const fixture = await extension.openFixture("signup.html", {
      origin: extension.foreignOrigin,
      access: false,
    });
    await fixture.page.focus("#pw");
    const popup = await extension.openPopup(`?tabId=${fixture.tab.id}`);
    assert.equal(await popup.page.locator("#btn-fill").isEnabled(), true);
    const status = await nextStatus(popup.page, () => popup.page.locator("#btn-fill").click());
    assert.deepEqual(status, { state: "bad", text: extension.message("fillBlocked") });
    assert.equal(await fixture.page.inputValue("#pw"), "");

    // A tab id that is not a number leaves Fill switched off.
    const lost = await extension.openPopup("?tabId=");
    assert.equal(await lost.page.locator("#btn-fill").isDisabled(), true);
    assert.equal(await text(lost.page, "#fill-hint"), extension.message("popupFillUnavailable"));
  });

  // Last on purpose: it looks back at everything the tests above did.
  test("only the options are ever stored, and no value", TIMEOUT, async () => {
    // Leave settings behind, as a user's last popup would.
    const { page } = await extension.openPopup();
    await selectTab(page, "secret");
    await until(
      "the tab to be saved",
      async () => (await extension.storage()).local["settings.v1"]?.tab,
      (tab) => tab === "secret",
    );

    const storage = await extension.storage();
    assert.deepEqual(Object.keys(storage.local), ["settings.v1"]);
    assert.deepEqual(Object.keys(storage.session), []);

    const changes = await extension.storageChanges();
    assert.ok(changes.length >= 10, "the tests above changed options");
    // Every write went to the options. The only other ones are the
    // notices that the notice test itself put into storage.session.
    const others = changes.filter(
      (change) => `${change.area}:${change.key}` !== "local:settings.v1",
    );
    assert.deepEqual(
      others.filter((change) => change.value).map((change) => `${change.area}:${change.key}`),
      Array(noticesLeft).fill("session:notice.v1"),
    );

    assert.ok(secrets.size >= 30, `the tests above showed values (${secrets.size})`);
    const haystack = JSON.stringify([storage, changes]);
    for (const secret of secrets) {
      assert.equal(haystack.includes(secret), false, "a value on display was stored");
    }
  });
});

describe("the popup in another UI language", () => {
  const openIn = async (language, check) => {
    const extension = await launchExtension({ language, pages: false });
    try {
      const popup = await extension.openPopup();
      await check(extension, popup.page);
      assert.deepEqual(await extension.endTest(), []);
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
