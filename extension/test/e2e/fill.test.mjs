// Filling a page: the context-menu item, the keyboard shortcut and the
// popup's Fill button, against the real build and its real permissions.
//
// The tests share one browser and one fixture tab and run in the order
// they are written: activeTab is granted once, by the first test.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  COMMAND_REPEAT_WINDOW_MS,
  MENU_ID,
  PLAIN_HTTP_HOST,
  badgeOf,
  clickMenuItem,
  collectExtensionErrors,
  grantActiveTab,
  launchExtension,
  openPopup,
  pressShortcut,
  restartWorker,
  serveFixtures,
  sleep,
  storageOf,
  tabOf,
  watchActionPopup,
  watchStorage,
} from "./helpers.mjs";

const SIGNUP = `<!doctype html><meta charset="utf-8"><title>Sign up</title>
<form>
  <input id="user" type="text" autocomplete="username">
  <input id="pw" type="password" autocomplete="new-password">
  <input id="pw2" type="password" autocomplete="new-password">
</form>
<form>
  <input id="pw16" type="password" maxlength="16">
  <input id="pw16-again" type="password" maxlength="16">
</form>
<input id="pw8" type="password" maxlength="8">
<input id="plain" type="text">`;

const framed = (src) => `<!doctype html><meta charset="utf-8"><title>Framed</title>
<iframe src="${src}"></iframe>`;

const TIMEOUT = { timeout: 60_000 };

describe("filling a page", () => {
  let extension;
  let fixtures;
  // A second server is a second origin: the port is part of it.
  let elsewhere;
  let page;
  let tab;
  let storageChanges;
  let actionPopup;
  let extensionErrors;
  // Every value the tests saw in a field. None of them may turn up
  // anywhere outside the page it was filled into.
  const generated = new Set();

  const values = (...ids) => Promise.all(ids.map((id) => page.inputValue(`#${id}`)));
  const reset = async (focus) => {
    for (const id of ["user", "pw", "pw2", "pw16", "pw16-again", "pw8", "plain"]) {
      await page.fill(`#${id}`, "");
    }
    await page.focus(`#${focus}`);
  };

  before(async () => {
    extension = await launchExtension();
    const routes = { "/signup": SIGNUP };
    fixtures = await serveFixtures(routes);
    elsewhere = await serveFixtures({ "/signup": SIGNUP });
    routes["/framed-same"] = framed("/signup");
    routes["/framed-cross"] = framed(`${elsewhere.origin}/signup`);
    extensionErrors = await collectExtensionErrors(extension);
    storageChanges = await watchStorage(extension);
    actionPopup = await watchActionPopup(extension);
    page = await extension.context.newPage();
    await page.goto(`${fixtures.origin}/signup`);
    await page.focus("#pw");
    tab = await tabOf(extension, page);
  });

  after(async () => {
    await extension?.close();
    await fixtures?.close();
    await elsewhere?.close();
  });

  test("a click on the toolbar button opens the popup and grants activeTab", TIMEOUT, async () => {
    assert.equal(tab.url, undefined, "no host permission: the extension must not see the URL");
    tab = await grantActiveTab(extension, page);
    assert.equal(tab.url, page.url());
    const popup = await actionPopup.waitFor("the popup to render", (state) => state.ready);
    assert.match(popup.output, /^[A-Za-z0-9]{20}$/);
    assert.equal(popup.notice, null);
    await actionPopup.close();
  });

  test("the context-menu item fills the password and its confirmation", TIMEOUT, async () => {
    await reset("pw");
    await clickMenuItem(extension, tab);
    const [user, pw, pw2] = await values("user", "pw", "pw2");
    generated.add(pw);
    assert.match(pw, /^[A-Za-z0-9]{20}$/);
    assert.equal(pw2, pw);
    assert.equal(user, "");
    assert.deepEqual(await badgeOf(extension, tab.id), {
      text: "OK",
      title: extension.message("fillOkConfirm"),
    });
  });

  test("a second fill replaces both fields with one new value", TIMEOUT, async () => {
    const [first] = await values("pw");
    await clickMenuItem(extension, tab);
    const [pw, pw2] = await values("pw", "pw2");
    generated.add(pw);
    assert.match(pw, /^[A-Za-z0-9]{20}$/);
    assert.notEqual(pw, first);
    assert.equal(pw2, pw, "the confirmation must not keep the first password");
    assert.equal((await badgeOf(extension, tab.id)).title, extension.message("fillOkConfirm"));
  });

  test("the shortcut fills a password field, once per key press", TIMEOUT, async () => {
    await reset("pw");
    await pressShortcut(extension, tab);
    const [pw, pw2] = await values("pw", "pw2");
    generated.add(pw);
    assert.match(pw, /^[A-Za-z0-9]{20}$/);
    assert.equal(pw2, pw);

    // A held key repeats: the browser delivers the command again and again.
    await pressShortcut(extension, tab);
    await pressShortcut(extension, tab);
    assert.deepEqual(await values("pw", "pw2"), [pw, pw], "a repeat must not fill again");

    await sleep(COMMAND_REPEAT_WINDOW_MS);
    await pressShortcut(extension, tab);
    const [next, nextAgain] = await values("pw", "pw2");
    generated.add(next);
    assert.notEqual(next, pw, "a new press after the repeat window fills again");
    assert.equal(nextAgain, next);
  });

  test(
    "the shortcut refuses a text field and leaves the reason for the popup",
    TIMEOUT,
    async () => {
      await reset("plain");
      await sleep(COMMAND_REPEAT_WINDOW_MS);
      const before = (await storageChanges()).length;
      await pressShortcut(extension, tab);
      assert.deepEqual(await values("plain", "pw"), ["", ""]);
      assert.deepEqual(await badgeOf(extension, tab.id), {
        text: "!",
        title: extension.message("fillNotPassword"),
      });
      const notices = (await storageChanges())
        .slice(before)
        .filter(
          (change) => change.area === "session" && change.key === "notice.v1" && change.value,
        );
      assert.equal(notices.length, 1, "one notice for the popup");
      assert.deepEqual(Object.keys(notices[0].value).sort(), ["at", "message"]);
      assert.equal(notices[0].value.message, extension.message("fillNotPassword"));
    },
  );

  test("the context-menu item fills a text field, and only that field", TIMEOUT, async () => {
    await reset("plain");
    await clickMenuItem(extension, tab);
    const [plain, pw] = await values("plain", "pw");
    generated.add(plain);
    assert.match(plain, /^[A-Za-z0-9]{20}$/);
    assert.equal(pw, "");
    assert.equal((await badgeOf(extension, tab.id)).title, extension.message("fillOk"));
  });

  test("a field with maxlength 16 gets a 16-character password", TIMEOUT, async () => {
    await reset("pw16");
    await clickMenuItem(extension, tab);
    const [pw, again] = await values("pw16", "pw16-again");
    generated.add(pw);
    assert.match(pw, /^[A-Za-z0-9]{16}$/);
    assert.equal(again, pw);
    assert.deepEqual(await badgeOf(extension, tab.id), {
      text: "OK",
      title: extension.message("fillOkShortened", "16"),
    });
  });

  // With the default settings the core refuses fewer than 14 characters.
  test(
    "a field with maxlength 8 is not filled and the message names the limit",
    TIMEOUT,
    async () => {
      await reset("pw8");
      await clickMenuItem(extension, tab);
      assert.deepEqual(await values("pw8"), [""]);
      assert.deepEqual(await badgeOf(extension, tab.id), {
        text: "!",
        title: extension.message("fillTooLong", "8"),
      });
    },
  );

  test("the popup fills the value on display, and again after Regenerate", TIMEOUT, async () => {
    await reset("pw");
    const popup = await openPopup(extension, `?tabId=${tab.id}`);
    const fill = popup.page.locator("#btn-fill");
    const status = popup.page.locator("#status");
    assert.equal(await fill.isEnabled(), true);

    const shown = await popup.page.locator("#output").textContent();
    await fill.click();
    await popup.page.waitForSelector("#status[data-state]");
    assert.equal(await status.getAttribute("data-state"), "ok");
    assert.equal(await status.textContent(), extension.message("fillOkConfirm"));
    assert.deepEqual(await values("pw", "pw2"), [shown, shown]);
    generated.add(shown);

    await popup.page.locator("#btn-generate").click();
    await popup.page.waitForFunction(
      (old) => document.getElementById("output").textContent !== old,
      shown,
    );
    const regenerated = await popup.page.locator("#output").textContent();
    await fill.click();
    await popup.page.waitForSelector("#status[data-state]");
    assert.deepEqual(await values("pw", "pw2"), [regenerated, regenerated]);
    generated.add(regenerated);

    // Any generator tab fills, not only Password.
    await popup.page.locator("#tab-passphrase").click();
    await popup.page.waitForFunction(() =>
      document.getElementById("output").textContent.includes("-"),
    );
    const passphrase = await popup.page.locator("#output").textContent();
    await page.focus("#plain");
    await popup.page.bringToFront();
    await fill.click();
    await popup.page.waitForSelector("#status[data-state]");
    assert.equal(await status.textContent(), extension.message("fillOk"));
    assert.deepEqual(await values("plain"), [passphrase]);
    generated.add(passphrase);

    assert.deepEqual(await popup.problems(), []);
    await popup.page.locator("#tab-password").click();
    await popup.page.close();
  });

  // 127.0.0.1 counts as a secure context even over http, so this page is
  // reached under a name that does not.
  test("the popup warns when the page it filled is not served over HTTPS", TIMEOUT, async () => {
    const plain = await extension.context.newPage();
    await plain.goto(`${fixtures.origin.replace("127.0.0.1", PLAIN_HTTP_HOST)}/signup`);
    assert.equal(await plain.evaluate(() => isSecureContext), false);
    await plain.focus("#pw");
    const plainTab = await grantActiveTab(extension, plain);
    const popup = await openPopup(extension, `?tabId=${plainTab.id}`);
    const shown = await popup.page.locator("#output").textContent();
    await popup.page.locator("#btn-fill").click();
    await popup.page.waitForSelector("#status[data-state]");
    assert.equal(await popup.page.locator("#status").getAttribute("data-state"), "ok");
    assert.equal(
      await popup.page.locator("#status").textContent(),
      `${extension.message("fillOkConfirm")} ${extension.message("popupFillInsecure")}`,
    );
    assert.equal(
      await popup.page.locator("#status .status-warning").textContent(),
      extension.message("popupFillInsecure"),
    );
    assert.deepEqual(
      [await plain.inputValue("#pw"), await plain.inputValue("#pw2")],
      [shown, shown],
    );
    generated.add(shown);
    assert.deepEqual(await popup.problems(), []);
    await popup.page.close();
    await plain.close();
    await page.bringToFront();
  });

  test(
    "a same-origin frame can be filled, a frame from another origin cannot",
    TIMEOUT,
    async () => {
      const outer = await extension.context.newPage();
      await outer.goto(`${fixtures.origin}/framed-same`);
      let outerTab = await grantActiveTab(extension, outer);
      const inner = outer.frames().find((frame) => frame !== outer.mainFrame());
      const innerValues = () => Promise.all([inner.inputValue("#pw"), inner.inputValue("#pw2")]);

      // The shortcut starts at the top document and follows the focus.
      await inner.focus("#pw");
      await pressShortcut(extension, outerTab);
      const [pw, pw2] = await innerValues();
      generated.add(pw);
      assert.match(pw, /^[A-Za-z0-9]{20}$/);
      assert.equal(pw2, pw);

      // The context menu names the frame that was clicked.
      const frames = await extension.worker().evaluate(
        async (tabId) =>
          (
            await chrome.scripting.executeScript({
              target: { tabId, allFrames: true },
              func: () => location.pathname,
            })
          ).map((result) => ({ frameId: result.frameId, path: result.result })),
        outerTab.id,
      );
      const frameId = frames.find((frame) => frame.path === "/signup")?.frameId;
      assert.ok(frameId > 0, JSON.stringify(frames));
      await clickMenuItem(extension, outerTab, frameId);
      const [next, nextAgain] = await innerValues();
      generated.add(next);
      assert.notEqual(next, pw);
      assert.equal(nextAgain, next);

      await outer.goto(`${fixtures.origin}/framed-cross`);
      outerTab = await grantActiveTab(extension, outer);
      const foreign = outer.frames().find((frame) => frame !== outer.mainFrame());
      assert.equal(new URL(foreign.url()).origin, elsewhere.origin);
      await foreign.focus("#pw");
      await sleep(COMMAND_REPEAT_WINDOW_MS);
      await pressShortcut(extension, outerTab);
      assert.equal(await foreign.inputValue("#pw"), "");
      assert.deepEqual(await badgeOf(extension, outerTab.id), {
        text: "!",
        title: extension.message("fillCrossOrigin"),
      });
      await outer.close();
      await page.bringToFront();
    },
  );

  test(
    "a failed fill opens the popup, which shows the reason and can fill instead",
    TIMEOUT,
    async () => {
      await reset("plain");
      await sleep(COMMAND_REPEAT_WINDOW_MS);
      // Earlier failures may have left one open; a second one cannot open then.
      await actionPopup.close();
      await pressShortcut(extension, tab);
      const popup = await actionPopup.waitFor("the popup to render", (state) => state.ready);
      assert.equal(popup.notice, extension.message("fillNotPassword"));
      assert.deepEqual(await values("plain"), [""]);

      // The popup fills text fields too. The page has lost the window focus
      // to the popup by now; the fill has to find the field all the same.
      await actionPopup.click("btn-fill");
      const filled = await actionPopup.waitFor("the fill to report", (state) => state.statusState);
      assert.equal(filled.statusState, "ok");
      assert.equal(filled.status, extension.message("fillOk"));
      assert.deepEqual(await values("plain"), [popup.output]);
      generated.add(popup.output);
      await actionPopup.close();
    },
  );

  test("another tab stays out of reach until the user acts there", TIMEOUT, async () => {
    const other = await extension.context.newPage();
    await other.goto(`${fixtures.origin}/signup`);
    await other.focus("#pw");
    const otherTab = await tabOf(extension, other);
    assert.equal(otherTab.url, undefined);
    await clickMenuItem(extension, otherTab);
    assert.deepEqual([await other.inputValue("#pw"), await other.inputValue("#pw2")], ["", ""]);
    assert.deepEqual(await badgeOf(extension, otherTab.id), {
      text: "!",
      title: extension.message("fillBlocked"),
    });
    await actionPopup.close();
    await other.close();
    await page.bringToFront();
  });

  test("a restarted service worker still fills", TIMEOUT, async () => {
    await reset("pw");
    const worker = extension.worker();
    assert.equal(await worker.evaluate(() => typeof globalThis.secretgen), "object");
    await restartWorker(extension, page);
    assert.equal(
      await extension.worker().evaluate(() => typeof globalThis.secretgen),
      "undefined",
      "the restarted worker has not loaded the WASM core yet",
    );
    await clickMenuItem(extension, tab);
    const [pw, pw2] = await values("pw", "pw2");
    generated.add(pw);
    assert.match(pw, /^[A-Za-z0-9]{20}$/);
    assert.equal(pw2, pw);
    assert.equal((await badgeOf(extension, tab.id)).text, "OK");
  });

  test("the badge and the tooltip clear themselves", TIMEOUT, async () => {
    const deadline = Date.now() + 8000;
    let badge;
    do {
      await sleep(250);
      badge = await badgeOf(extension, tab.id);
    } while (badge.text !== "" && Date.now() < deadline);
    assert.deepEqual(badge, { text: "", title: extension.message("actionTitle") });
  });

  // Typed options are saved after a short pause in typing. Runs late in
  // this file because it changes the saved password length.
  test("an option typed just before the popup closes is still saved", TIMEOUT, async () => {
    await actionPopup.close();
    await grantActiveTab(extension, page);
    await actionPopup.waitFor("the popup to render", (state) => state.ready);
    await actionPopup.typeAndClose("pw-length", "41");
    const deadline = Date.now() + 5000;
    let saved;
    do {
      await sleep(50);
      saved = (await storageOf(extension)).local["settings.v1"]?.password.length;
    } while (saved !== 41 && Date.now() < deadline);
    assert.equal(saved, 41);
  });

  test("no generated value was stored or shown outside the page", TIMEOUT, async () => {
    assert.ok(generated.size >= 8, "the tests above generate values");
    const storage = await storageOf(extension);
    assert.deepEqual(
      Object.keys(storage.local).filter((key) => key !== "settings.v1"),
      [],
      "storage.local holds nothing but the options",
    );
    const tabs = await extension.worker().evaluate(() => chrome.tabs.query({}));
    const haystack = JSON.stringify([storage, await storageChanges(), tabs]);
    for (const value of generated) {
      assert.equal(haystack.includes(value), false, "a generated value left the page");
    }
  });

  test(
    "the menu item is created again on browser start, without a duplicate",
    TIMEOUT,
    async () => {
      const exists = () =>
        extension.worker().evaluate(
          (id) =>
            new Promise((resolve) => {
              chrome.contextMenus.update(id, {}, () => resolve(!chrome.runtime.lastError));
            }),
          MENU_ID,
        );
      assert.equal(await exists(), true, "created when the extension was installed");
      await extension.worker().evaluate(() => {
        chrome.runtime.onStartup.dispatch();
      });
      // removeAll and create report through callbacks; give them time to
      // run, so that an error of theirs is in the log the next test reads.
      await sleep(500);
      assert.equal(await exists(), true);
    },
  );

  test("the extension logged no errors", TIMEOUT, async () => {
    const log = await extensionErrors();
    assert.equal(log.collecting, true);
    assert.deepEqual(log.manifestErrors, []);
    assert.deepEqual(log.installWarnings, []);
    assert.deepEqual(log.runtimeErrors, []);

    // The empty list above means something only if the log records. An
    // error made on purpose shows that it does, and that the item exists.
    await extension.worker().evaluate((id) => {
      chrome.contextMenus.create({ id, title: "duplicate", contexts: ["editable"] });
    }, MENU_ID);
    const deadline = Date.now() + 5000;
    let recorded;
    do {
      await sleep(100);
      recorded = (await extensionErrors()).runtimeErrors;
    } while (recorded.length === 0 && Date.now() < deadline);
    assert.equal(recorded.length, 1, JSON.stringify(recorded));
    assert.match(recorded[0], /duplicate id fill-password/);
  });
});
