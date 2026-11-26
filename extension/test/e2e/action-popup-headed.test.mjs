// The action popup in a browser with a window, which is the only place
// where the browser sizes the popup to its content and where the popup
// takes the window focus away from the page as it does for a user.
//
// Needs an X display and is skipped without one. On a machine without a
// screen:
//
//   xvfb-run -a npm run test:e2e
//
// which runs every other test file headless as usual.
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { launchExtension, showRealFocus, until } from "./helpers.mjs";

const TIMEOUT = { timeout: 60_000 };
const NO_DISPLAY = process.env.DISPLAY
  ? false
  : "no X display (run under xvfb-run to include this file)";

describe("the action popup in a browser window", { skip: NO_DISPLAY }, () => {
  let extension;

  /** Size and scroll size of the popup's window, read inside the popup. */
  const popupSize = () => extension.actionPopup.measure();

  before(async () => {
    extension = await launchExtension({ headless: false });
    assert.ok(extension.popupOpens, "a browser with a window opens its action popup");
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

  test("is as large as its content on every tab, without scrollbars", TIMEOUT, async () => {
    const { page } = await extension.openFixture("signup.html");
    await extension.actionPopup.open(page);
    for (const tab of ["password", "passphrase", "secret", "apiKey", "pin", "entropy"]) {
      await extension.actionPopup.click(`tab-${tab}`);
      // With the PIN and its warning, not only the hint in its place.
      if (tab === "pin") await extension.actionPopup.click("pin-ack");
      // The browser resizes the popup after the content changed.
      const size = await until(
        `the popup to fit the ${tab} tab`,
        popupSize,
        (size) => size.selected === `tab-${tab}` && size.height === size.contentHeight,
        5000,
      );
      assert.equal(size.width, 360, tab);
      assert.equal(size.scrollWidth, 360, `${tab}: nothing wider than the popup`);
      assert.ok(size.height <= 600, `${tab}: ${size.height} px, the browser cuts a popup at 600`);
      assert.equal(size.scrollHeight, size.height, `${tab}: no vertical scrollbar`);
    }
  });

  test("fills the page under it, which has lost the window focus to it", TIMEOUT, async () => {
    const fixture = await extension.openFixture("signup.html");
    await fixture.page.locator("#pw").click();
    await showRealFocus(extension, fixture.page);

    await extension.actionPopup.open(fixture.page);
    const popup = await extension.actionPopup.waitFor("a value", (state) => state.output !== "");
    assert.match(popup.output, /^[A-Za-z0-9]{20}$/);
    assert.equal(popup.fillEnabled, true);
    await until(
      "the page to lose the window focus",
      () => fixture.page.evaluate(() => document.hasFocus()),
      (focused) => focused === false,
    );

    await extension.actionPopup.click("btn-fill");
    const filled = await extension.actionPopup.waitFor(
      "the fill to report",
      (state) => state.statusState !== null,
    );
    assert.equal(filled.statusState, "ok");
    assert.equal(filled.status, extension.message("fillOkConfirm"));
    assert.deepEqual(
      [await fixture.page.inputValue("#pw"), await fixture.page.inputValue("#pw2")],
      [popup.output, popup.output],
    );
  });
});
