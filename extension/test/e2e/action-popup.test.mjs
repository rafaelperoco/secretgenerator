// The real action popup, the one the browser opens below the toolbar
// button, as opposed to popup.html in a tab. It is not a tab, so the tests
// reach it through a second page of the extension (see `actionPopup` in
// helpers.mjs).
//
// A headless browser has no window to show a popup in, and whether it
// opens one all the same is up to the Chromium version. Where it does not,
// these tests are skipped with that reason; the same behaviour is then
// covered for popup.html in a tab only.
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { launchExtension, showRealFocus, until } from "./helpers.mjs";

const TIMEOUT = { timeout: 60_000 };
const PASSWORD = /^[A-Za-z0-9]{20}$/;

describe("the action popup", () => {
  let extension;
  // Every value the popup showed. None of them may turn up in storage.
  const shown = new Set();

  /** Skips the test where the browser shows no popup. Returns true then. */
  const withoutPopup = (t) => {
    if (extension.popupOpens) return false;
    t.skip("this browser does not open the action popup without a window");
    return true;
  };

  const values = (page, ...ids) => Promise.all(ids.map((id) => page.inputValue(`#${id}`)));

  before(async () => {
    extension = await launchExtension();
  });

  beforeEach(async () => {
    await extension.worker().evaluate(() => chrome.storage.local.clear());
  });

  afterEach(async () => {
    assert.deepEqual(await extension.endTest(), []);
  });

  after(async () => {
    await extension?.close();
  });

  test(
    "opened from the toolbar, it fills the page under it, which has lost the focus",
    TIMEOUT,
    async (t) => {
      if (withoutPopup(t)) return;
      const fixture = await extension.openFixture("signup.html", { access: false });
      if (extension.access.mode === "activeTab") {
        assert.equal(fixture.tab.url, undefined, "before the click, the page is out of reach");
      }
      await fixture.page.locator("#pw").click();
      await showRealFocus(extension, fixture.page);

      const tab = await extension.actionPopup.open(fixture.page);
      const popup = await extension.actionPopup.waitFor("a value", (state) => state.output !== "");
      shown.add(popup.output);
      assert.match(popup.output, PASSWORD);
      assert.equal(popup.notice, null);
      assert.equal(popup.fillEnabled, true, "the popup found the page to fill");

      // The popup has taken the window focus, which is the situation Fill
      // has to work in. The field is still the active element of its page.
      await until(
        "the page to lose the window focus",
        () => fixture.page.evaluate(() => document.hasFocus()),
        (focused) => focused === false,
      );
      assert.equal(await fixture.page.evaluate(() => document.activeElement.id), "pw");

      await extension.actionPopup.click("btn-fill");
      const filled = await extension.actionPopup.waitFor(
        "the fill to report",
        (state) => state.statusState !== null,
      );
      assert.equal(filled.statusState, "ok");
      assert.equal(filled.status, extension.message("fillOkConfirm"));
      assert.deepEqual(await values(fixture.page, "pw", "pw2"), [popup.output, popup.output]);

      if (extension.access.mode === "activeTab") {
        // The click that opened the popup is what granted the access.
        const now = await extension.worker().evaluate((id) => chrome.tabs.get(id), tab.id);
        assert.equal(now.url, fixture.page.url());
      }
    },
  );

  test(
    "a failed fill opens it with the reason, shown once, and Fill works from there",
    TIMEOUT,
    async (t) => {
      if (withoutPopup(t)) return;
      const { page, tab } = await extension.openFixture("signup.html");
      await page.locator("#note").click();
      await showRealFocus(extension, page);
      await extension.pressShortcut(tab);
      const popup = await extension.actionPopup.waitFor(
        "the popup to render",
        (state) => state.ready,
      );
      shown.add(popup.output);
      assert.equal(popup.notice, extension.message("fillNotPassword"));
      assert.match(popup.output, PASSWORD);
      assert.deepEqual(await values(page, "note"), [""]);
      assert.deepEqual(
        Object.keys((await extension.storage()).session),
        [],
        "the notice was taken",
      );

      // The popup fills text fields too.
      await extension.actionPopup.click("btn-fill");
      const filled = await extension.actionPopup.waitFor(
        "the fill to report",
        (state) => state.statusState !== null,
      );
      assert.equal(filled.statusState, "ok");
      assert.equal(filled.status, extension.message("fillOk"));
      assert.deepEqual(await values(page, "note", "pw"), [popup.output, ""]);

      // Opened again, the popup has nothing left to report.
      await extension.actionPopup.open(page);
      const again = await extension.actionPopup.waitFor("a value", (state) => state.output !== "");
      shown.add(again.output);
      assert.equal(again.notice, null);
    },
  );

  test("on a page of the browser itself, Fill is switched off and says why", TIMEOUT, async (t) => {
    if (withoutPopup(t)) return;
    const page = await extension.context.newPage();
    try {
      await page.goto("chrome://version/");
      await extension.actionPopup.open(page);
      const popup = await extension.actionPopup.waitFor("a value", (state) => state.output !== "");
      shown.add(popup.output);
      assert.equal(popup.fillEnabled, false);
      assert.equal(popup.fillHint, extension.message("popupFillUnavailable"));
    } finally {
      await extension.actionPopup.close();
      await page.close();
    }
  });

  // Typed options are saved after a short pause in typing, and at once as
  // well: a popup closes without warning.
  test("an option typed just before it closes is still saved", TIMEOUT, async (t) => {
    if (withoutPopup(t)) return;
    const { page } = await extension.openFixture("signup.html");
    await extension.actionPopup.open(page);
    await extension.actionPopup.typeAndClose("pw-length", "41");
    await until(
      "the length to be saved",
      async () => (await extension.storage()).local["settings.v1"]?.password.length,
      (length) => length === 41,
      5000,
    );
    await extension.actionPopup.open(page);
    const reopened = await extension.actionPopup.waitFor("a value", (state) => state.output !== "");
    shown.add(reopened.output);
    assert.equal(reopened.output.length, 41);
  });

  test("no value it showed is in the extension's storage", TIMEOUT, async (t) => {
    if (withoutPopup(t)) return;
    assert.ok(shown.size >= 4, `the tests above showed values (${shown.size})`);
    const haystack = JSON.stringify([await extension.storage(), await extension.storageChanges()]);
    for (const value of shown) {
      assert.equal(haystack.includes(value), false, "a value on display was stored");
    }
  });
});
