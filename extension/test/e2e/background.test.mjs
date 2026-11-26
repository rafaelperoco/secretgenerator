// The background context: the context-menu item and the keyboard shortcut,
// which generate a password and fill it without any UI of their own, and
// the feedback they leave on the toolbar badge and for the popup.
//
// Automation cannot click a context-menu item or press an extension
// shortcut. The tests deliver the two events inside the service worker,
// through the dispatch() method of the event objects, which calls the
// listeners background.js registered exactly as the browser would. What
// that leaves untested is listed in the README: that the item shows up on
// a field, that the key is bound, and that the gesture grants activeTab.
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import {
  COMMAND,
  COMMAND_REPEAT_WINDOW_MS,
  FALLBACK_HOST_PERMISSIONS,
  MENU_ID,
  collectExtensionErrors,
  launchExtension,
  restartWorker,
  sleep,
  until,
} from "./helpers.mjs";

const TIMEOUT = { timeout: 60_000 };
const PASSWORD = /^[A-Za-z0-9]{20}$/;

describe("the context-menu item and the shortcut", () => {
  let extension;
  let extensionErrors;
  // Every value the tests saw in a field. None of them may turn up
  // anywhere outside the page it was filled into.
  const generated = new Set();

  /** The values of fields of a page or frame, by id. Remembers what it saw. */
  async function values(scope, ...ids) {
    const found = await Promise.all(ids.map((id) => scope.locator(`#${id}`).inputValue()));
    for (const value of found) if (value !== "") generated.add(value);
    return found;
  }

  /** Colours of the badge of a tab, as [r, g, b, a]. */
  const badgeColours = (tabId) =>
    extension.worker().evaluate(
      async (tabId) => ({
        background: await chrome.action.getBadgeBackgroundColor({ tabId }),
        text: await chrome.action.getBadgeTextColor({ tabId }),
      }),
      tabId,
    );

  const okBadge = (key, ...substitutions) => ({
    text: "OK",
    title: extension.message(key, ...substitutions),
  });
  const failBadge = (key, ...substitutions) => ({
    text: "!",
    title: extension.message(key, ...substitutions),
  });

  /**
   * Runs `action` and returns the notices it left for the popup. Read from
   * the record of storage writes: a popup that opens takes the notice out
   * of storage again.
   */
  async function noticesFrom(action) {
    const before = (await extension.storageChanges()).length;
    await action();
    return (await extension.storageChanges())
      .slice(before)
      .filter((change) => change.area === "session" && change.key === "notice.v1" && change.value)
      .map((change) => change.value);
  }

  /** How often the page heard a fill of the field with this id. */
  const fillsOf = (page, field) =>
    page.evaluate(
      (field) =>
        window.fixtureEvents.filter((event) => event.type === "input" && event.field === field)
          .length,
      field,
    );

  /** The extension's id for the one frame of a page that shows `pathname`. */
  async function frameIdOf(tab, pathname) {
    const frames = await extension.worker().evaluate(
      async (tabId) =>
        (
          await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            func: () => location.pathname,
          })
        ).map((result) => ({ frameId: result.frameId, pathname: result.result })),
      tab.id,
    );
    const found = frames.filter((frame) => frame.pathname === pathname);
    assert.equal(found.length, 1, JSON.stringify(frames));
    assert.ok(found[0].frameId > 0, "a child frame");
    return found[0].frameId;
  }

  before(async () => {
    extension = await launchExtension();
    extensionErrors = await collectExtensionErrors(extension);
  });

  beforeEach(async () => {
    await extension.worker().evaluate(() => chrome.storage.local.clear());
  });

  afterEach(async () => {
    assert.deepEqual(await extension.endTest(), [], "a popup logged or was refused something");
  });

  after(async () => {
    await extension?.close();
  });

  test("the service worker runs with its listeners and no messaging surface", TIMEOUT, async () => {
    const workers = extension.context.serviceWorkers().map((worker) => worker.url());
    assert.deepEqual(workers, [`chrome-extension://${extension.id}/background.js`]);
    // A worker that threw while loading can still be registered, so the
    // listeners are what shows that background.js ran to its end.
    const listeners = await extension.worker().evaluate(() => ({
      installed: chrome.runtime.onInstalled.hasListeners(),
      startup: chrome.runtime.onStartup.hasListeners(),
      menu: chrome.contextMenus.onClicked.hasListeners(),
      command: chrome.commands.onCommand.hasListeners(),
      message: chrome.runtime.onMessage.hasListeners(),
      messageExternal: chrome.runtime.onMessageExternal.hasListeners(),
      connect: chrome.runtime.onConnect.hasListeners(),
      connectExternal: chrome.runtime.onConnectExternal.hasListeners(),
    }));
    assert.deepEqual(listeners, {
      installed: true,
      startup: true,
      menu: true,
      command: true,
      message: false,
      messageExternal: false,
      connect: false,
      connectExternal: false,
    });
    const commands = await extension.worker().evaluate(() => chrome.commands.getAll());
    assert.deepEqual(
      commands.filter((command) => command.name === COMMAND).map((command) => command.shortcut),
      ["Alt+Shift+G"],
    );

    // What the browser granted. In the fallback mode the hosts come from
    // the temporary copy; the shipped manifest is checked in dist.test.mjs.
    const granted = await extension.worker().evaluate(() => chrome.permissions.getAll());
    assert.deepEqual(granted.permissions.sort(), [
      "activeTab",
      "contextMenus",
      "scripting",
      "storage",
    ]);
    assert.deepEqual(
      granted.origins.sort(),
      extension.access.mode === "activeTab" ? [] : [...FALLBACK_HOST_PERMISSIONS].sort(),
    );
  });

  test("the context-menu item fills the password and its confirmation", TIMEOUT, async () => {
    const { page, tab } = await extension.openFixture("signup.html");
    await page.locator("#pw").click();
    await extension.clickMenuItem(tab);
    const [user, pw, pw2, note] = await values(page, "user", "pw", "pw2", "note");
    assert.match(pw, PASSWORD);
    // The default settings require all three.
    for (const required of [/[a-z]/, /[A-Z]/, /[0-9]/]) assert.match(pw, required);
    assert.equal(pw2, pw);
    assert.deepEqual([user, note], ["", ""]);
    assert.deepEqual(await extension.badgeOf(tab.id), okBadge("fillOkConfirm"));
    // White on green, #15803d.
    assert.deepEqual(await badgeColours(tab.id), {
      background: [21, 128, 61, 255],
      text: [255, 255, 255, 255],
    });

    // A second click replaces both fields with one new value.
    await extension.clickMenuItem(tab);
    const [next, nextConfirm] = await values(page, "pw", "pw2");
    assert.match(next, PASSWORD);
    assert.notEqual(next, pw);
    assert.equal(nextConfirm, next, "the confirmation must not keep the first password");
    assert.deepEqual(await extension.badgeOf(tab.id), okBadge("fillOkConfirm"));
  });

  test("the shortcut fills the focused password field and its confirmation", TIMEOUT, async () => {
    const { page, tab } = await extension.openFixture("signup.html");
    await page.locator("#pw").click();
    const notices = await noticesFrom(() => extension.pressShortcut(tab));
    const [user, pw, pw2] = await values(page, "user", "pw", "pw2");
    assert.match(pw, PASSWORD);
    assert.equal(pw2, pw);
    assert.equal(user, "");
    assert.deepEqual(await extension.badgeOf(tab.id), okBadge("fillOkConfirm"));
    assert.deepEqual(notices, [], "a plain success leaves nothing for the popup");
  });

  test("a shortcut that arrives without a tab goes to the active tab", TIMEOUT, async () => {
    const { page } = await extension.openFixture("signup.html");
    await page.locator("#pw").click();
    await page.bringToFront();
    const settled = await extension.worker().evaluate(async (command) => {
      const results = chrome.commands.onCommand.dispatch(command).results ?? [];
      return (await Promise.allSettled(results)).map((result) => result.status);
    }, COMMAND);
    assert.deepEqual(settled, ["fulfilled"]);
    const [pw, pw2] = await values(page, "pw", "pw2");
    assert.match(pw, PASSWORD);
    assert.equal(pw2, pw);
  });

  test("events meant for something else are ignored", TIMEOUT, async () => {
    const { page, tab } = await extension.openFixture("signup.html");
    await page.locator("#pw").click();
    const before = (await extension.storageChanges()).length;
    const returned = await extension.worker().evaluate(
      ({ tab, menuId }) => {
        const info = { frameId: 0, editable: true };
        return [
          // Another item, another command, and a click that names no tab.
          chrome.contextMenus.onClicked.dispatch({ ...info, menuItemId: "another-item" }, tab),
          chrome.commands.onCommand.dispatch("another-command", tab),
          chrome.contextMenus.onClicked.dispatch({ ...info, menuItemId: menuId }),
        ].map((dispatched) => dispatched?.results ?? []);
      },
      { tab, menuId: MENU_ID },
    );
    assert.deepEqual(returned, [[], [], []], "no listener started a fill");
    assert.deepEqual(await values(page, "pw", "pw2"), ["", ""]);
    assert.deepEqual(await extension.badgeOf(tab.id), {
      text: "",
      title: extension.message("actionTitle"),
    });
    assert.equal((await extension.storageChanges()).length, before);
  });

  test("a held shortcut key fills once, the next press fills again", TIMEOUT, async () => {
    const { page, tab } = await extension.openFixture("signup.html");
    await page.locator("#pw").click();
    // A held key repeats: the browser delivers the command again and again.
    // Counted in the page, because repeated fills would agree with each
    // other and could not be told from one by looking at the fields.
    await extension.pressShortcut(tab, 5);
    assert.equal(await fillsOf(page, "pw"), 1, "a held key fills once");
    const [held, heldConfirm] = await values(page, "pw", "pw2");
    assert.match(held, PASSWORD);
    assert.equal(heldConfirm, held);

    // The guard is a span of time; there is nothing else to wait for.
    await sleep(COMMAND_REPEAT_WINDOW_MS);
    await extension.pressShortcut(tab);
    assert.equal(await fillsOf(page, "pw"), 2);
    const [next, nextConfirm] = await values(page, "pw", "pw2");
    assert.notEqual(next, held, "a new press after the repeat window fills again");
    assert.equal(nextConfirm, next);
  });

  test(
    "the shortcut refuses a text field and leaves the reason for the popup",
    TIMEOUT,
    async () => {
      const { page, tab } = await extension.openFixture("signup.html");
      await page.locator("#note").click();
      const notices = await noticesFrom(() => extension.pressShortcut(tab));
      assert.deepEqual(await values(page, "note", "user", "pw", "pw2"), ["", "", "", ""]);
      assert.deepEqual(await extension.badgeOf(tab.id), failBadge("fillNotPassword"));
      // White on red, #b91c1c.
      assert.deepEqual(await badgeColours(tab.id), {
        background: [185, 28, 28, 255],
        text: [255, 255, 255, 255],
      });
      assert.equal(notices.length, 1, "one notice in storage.session");
      assert.deepEqual(Object.keys(notices[0]).sort(), ["at", "message"]);
      assert.equal(notices[0].message, extension.message("fillNotPassword"));
      assert.equal(typeof notices[0].at, "number");
      assert.equal(await fillsOf(page, "note"), 0, "the page heard nothing");
    },
  );

  test("the context-menu item fills a text field, and only that field", TIMEOUT, async () => {
    const { page, tab } = await extension.openFixture("signup.html");
    await page.locator("#note").click();
    await extension.clickMenuItem(tab);
    const [note, user, pw, pw2] = await values(page, "note", "user", "pw", "pw2");
    assert.match(note, PASSWORD);
    assert.deepEqual([user, pw, pw2], ["", "", ""]);
    assert.deepEqual(await extension.badgeOf(tab.id), okBadge("fillOk"));
  });

  test("a field with maxlength 16 gets a 16-character password", TIMEOUT, async () => {
    const { page, tab } = await extension.openFixture("limits.html");
    await page.locator("#pw16").click();
    const notices = await noticesFrom(() => extension.clickMenuItem(tab));
    const [pw, confirm] = await values(page, "pw16", "pw16-confirm");
    assert.match(pw, /^[A-Za-z0-9]{16}$/);
    assert.equal(confirm, pw);
    assert.deepEqual(await extension.badgeOf(tab.id), okBadge("fillOkShortened", "16"));
    assert.deepEqual(notices, []);

    // The shortcut shortens in the same way.
    const second = await extension.openFixture("limits.html");
    await second.page.locator("#pw16").click();
    await extension.pressShortcut(second.tab);
    const [viaShortcut] = await values(second.page, "pw16");
    assert.match(viaShortcut, /^[A-Za-z0-9]{16}$/);
    assert.deepEqual(await extension.badgeOf(second.tab.id), okBadge("fillOkShortened", "16"));
  });

  // With the default settings the core refuses fewer than 14 characters.
  test(
    "a field with maxlength 8 is not filled and the message names the limit",
    TIMEOUT,
    async () => {
      const { page, tab } = await extension.openFixture("limits.html");
      await page.locator("#pw8").click();
      const notices = await noticesFrom(() => extension.clickMenuItem(tab));
      assert.deepEqual(await values(page, "pw8", "pw8-confirm"), ["", ""]);
      assert.deepEqual(await extension.badgeOf(tab.id), failBadge("fillTooLong", "8"));
      assert.deepEqual(
        notices.map((notice) => notice.message),
        [extension.message("fillTooLong", "8")],
      );
    },
  );

  test("both use the Password options saved in the popup", TIMEOUT, async () => {
    const popup = await extension.openPopup();
    await popup.page.locator("#pw-length").fill("32");
    await popup.page.locator("#pw-charset").selectOption("alphanum-symbols-v1");
    await popup.page.locator("#pw-class-symbol").check();
    await until(
      "the options to be saved",
      async () => (await extension.storage()).local["settings.v1"]?.password,
      (saved) => saved?.length === 32 && saved.requiredClasses.includes("symbol"),
    );

    const { page, tab } = await extension.openFixture("signup.html");
    await page.locator("#pw").click();
    await extension.clickMenuItem(tab);
    const [pw, pw2] = await values(page, "pw", "pw2");
    assert.equal(pw.length, 32);
    assert.match(pw, /[^A-Za-z0-9]/, "a symbol is required now");
    assert.equal(pw2, pw);

    const second = await extension.openFixture("signup.html");
    await second.page.locator("#pw").click();
    await extension.pressShortcut(second.tab);
    const [viaShortcut] = await values(second.page, "pw");
    assert.equal(viaShortcut.length, 32);
    assert.match(viaShortcut, /[^A-Za-z0-9]/);
  });

  test("saved options the core refuses are reported with the core's reason", TIMEOUT, async () => {
    const popup = await extension.openPopup();
    await popup.page.locator("#pw-length").fill("8");
    await popup.page.waitForSelector("#error:not([hidden])");
    const reason = await popup.page.locator("#error").textContent();
    assert.match(reason, /entropy/i);
    await until(
      "the length to be saved",
      async () => (await extension.storage()).local["settings.v1"]?.password.length,
      (length) => length === 8,
    );

    const { page, tab } = await extension.openFixture("signup.html");
    await page.locator("#pw").click();
    const notices = await noticesFrom(() => extension.clickMenuItem(tab));
    assert.deepEqual(await values(page, "pw", "pw2"), ["", ""]);
    assert.deepEqual(await extension.badgeOf(tab.id), failBadge("fillGenerateFailed", reason));
    assert.deepEqual(
      notices.map((notice) => notice.message),
      [extension.message("fillGenerateFailed", reason)],
    );
  });

  test("damaged stored options fall back to the defaults", TIMEOUT, async () => {
    // Wrong types everywhere: the core's bindings would not survive them.
    await extension.worker().evaluate(() =>
      chrome.storage.local.set({
        "settings.v1": { password: { length: "abc", charsetId: 5, requiredClasses: "x" }, pin: 1 },
      }),
    );
    const { page, tab } = await extension.openFixture("signup.html");
    await page.locator("#pw").click();
    await extension.clickMenuItem(tab);
    const [pw, pw2] = await values(page, "pw", "pw2");
    assert.match(pw, PASSWORD);
    assert.equal(pw2, pw);
    assert.deepEqual(await extension.badgeOf(tab.id), okBadge("fillOkConfirm"));
  });

  test("a page that rewrites the value gets the OK badge with a warning", TIMEOUT, async () => {
    const { page, tab } = await extension.openFixture("refusals.html");
    await page.locator("#uppercase").click();
    const notices = await noticesFrom(() => extension.clickMenuItem(tab));
    const [value] = await values(page, "uppercase");
    assert.match(value, /^[A-Z0-9]{20}$/);
    assert.deepEqual(await extension.badgeOf(tab.id), okBadge("fillModified"));
    // The badge goes away after a few seconds; this needs the user's eye.
    assert.deepEqual(
      notices.map((notice) => notice.message),
      [extension.message("fillModified")],
    );
  });

  test(
    "in a same-origin frame, the shortcut follows the focus and the menu names the frame",
    TIMEOUT,
    async () => {
      const { page, tab } = await extension.openFixture("frame.html?src=/signup.html");
      const frame = page.frameLocator("#frame");
      await frame.locator("#pw").click();

      // The shortcut starts at the top document and follows the focus.
      await extension.pressShortcut(tab);
      const [pw, pw2] = await values(frame, "pw", "pw2");
      assert.match(pw, PASSWORD);
      assert.equal(pw2, pw);
      assert.deepEqual(await extension.badgeOf(tab.id), okBadge("fillOkConfirm"));

      // The context menu names the frame that was clicked.
      const frameId = await frameIdOf(tab, "/signup.html");
      await extension.clickMenuItem(tab, frameId);
      const [next, nextConfirm] = await values(frame, "pw", "pw2");
      assert.match(next, PASSWORD);
      assert.notEqual(next, pw);
      assert.equal(nextConfirm, next);
      assert.deepEqual(await extension.badgeOf(tab.id), okBadge("fillOkConfirm"));
    },
  );

  test("a click in a frame from another origin is refused as blocked", TIMEOUT, async () => {
    // The extension cannot ask for the id of a frame it has no access to.
    // A frame keeps its id when it navigates, so the id is read while the
    // frame shows a page of the tab's own origin.
    const { page, tab } = await extension.openFixture("frame.html?src=/blank.html");
    const frameId = await frameIdOf(tab, "/blank.html");
    const foreign = `${extension.foreignOrigin}/signup.html`;
    await page.evaluate((src) => {
      document.getElementById("frame").src = src;
    }, foreign);
    const frame = page.frameLocator("#frame");
    await frame.locator("#pw").click();
    assert.equal(page.frames()[1].url(), foreign);

    const notices = await noticesFrom(() => extension.clickMenuItem(tab, frameId));
    assert.deepEqual(await values(frame, "pw", "pw2", "user"), ["", "", ""]);
    assert.deepEqual(await extension.badgeOf(tab.id), failBadge("fillBlocked"));
    assert.deepEqual(
      notices.map((notice) => notice.message),
      [extension.message("fillBlocked")],
    );

    // The shortcut starts in the top document, finds the focus inside a
    // frame it cannot enter, and says so.
    await extension.pressShortcut(tab);
    assert.deepEqual(await values(frame, "pw", "pw2", "user"), ["", "", ""]);
    assert.deepEqual(await extension.badgeOf(tab.id), failBadge("fillCrossOrigin"));
  });

  test("a tab the extension has no access to is refused as blocked", TIMEOUT, async () => {
    // Another site: no host permission covers it, and nobody invoked the
    // extension there.
    const { page, tab } = await extension.openFixture("signup.html", {
      origin: extension.foreignOrigin,
      access: false,
    });
    assert.equal(tab.url, undefined, "the extension must not even see the address");
    await page.locator("#pw").click();
    await extension.clickMenuItem(tab);
    assert.deepEqual(await values(page, "pw", "pw2"), ["", ""]);
    assert.deepEqual(await extension.badgeOf(tab.id), failBadge("fillBlocked"));

    const viaShortcut = await extension.openFixture("signup.html", {
      origin: extension.foreignOrigin,
      access: false,
    });
    await viaShortcut.page.locator("#pw").click();
    await extension.pressShortcut(viaShortcut.tab);
    assert.deepEqual(await values(viaShortcut.page, "pw", "pw2"), ["", ""]);
    assert.deepEqual(await extension.badgeOf(viaShortcut.tab.id), failBadge("fillBlocked"));
  });

  test(
    "with the shipped permissions, a page is out of reach until the user acts there",
    TIMEOUT,
    async (t) => {
      if (extension.access.mode !== "activeTab") {
        t.skip("the fallback build has host permissions for the fixture pages");
        return;
      }
      const { page, tab } = await extension.openFixture("signup.html", { access: false });
      assert.equal(tab.url, undefined, "no host permission: the extension must not see the URL");
      await page.locator("#pw").click();
      await extension.clickMenuItem(tab);
      assert.deepEqual(await values(page, "pw", "pw2"), ["", ""]);
      assert.deepEqual(await extension.badgeOf(tab.id), failBadge("fillBlocked"));

      const granted = await extension.grantAccess(page);
      assert.equal(granted.url, page.url());
      await extension.clickMenuItem(granted);
      const [pw, pw2] = await values(page, "pw", "pw2");
      assert.match(pw, PASSWORD);
      assert.equal(pw2, pw);
      assert.deepEqual(await extension.badgeOf(tab.id), okBadge("fillOkConfirm"));
    },
  );

  test("a stopped service worker starts again and fills", TIMEOUT, async () => {
    const { page, tab } = await extension.openFixture("signup.html");
    await page.locator("#pw").click();
    await extension.clickMenuItem(tab);
    const [first] = await values(page, "pw");
    assert.match(first, PASSWORD);
    assert.equal(await extension.worker().evaluate(() => typeof globalThis.secretgen), "object");

    await restartWorker(extension, page);
    assert.equal(
      await extension.worker().evaluate(() => typeof globalThis.secretgen),
      "undefined",
      "the new worker has not loaded the WASM core yet",
    );
    await extension.clickMenuItem(tab);
    const [pw, pw2] = await values(page, "pw", "pw2");
    assert.match(pw, PASSWORD);
    assert.notEqual(pw, first);
    assert.equal(pw2, pw);
    assert.deepEqual(await extension.badgeOf(tab.id), okBadge("fillOkConfirm"));

    // The shortcut finds its listener in the new worker as well.
    await extension.pressShortcut(tab);
    const [viaShortcut] = await values(page, "pw");
    assert.match(viaShortcut, PASSWORD);
    assert.notEqual(viaShortcut, pw);
  });

  test("a core that stopped is replaced, and the next fill works", TIMEOUT, async () => {
    const { page, tab } = await extension.openFixture("signup.html");
    await page.locator("#pw").click();
    await extension.clickMenuItem(tab);
    const [first] = await values(page, "pw");
    assert.match(first, PASSWORD);

    // An option of the wrong type, which the extension never sends, is
    // fatal to the core: the Go program panics and exits, or the call
    // traps, depending on the compiler that built it.
    await extension.worker().evaluate(() => {
      try {
        globalThis.secretgen.password({ length: "twenty" });
      } catch {
        // The trap. The program is gone either way.
      }
    });

    // The first click may still meet the dead program. It then says so,
    // fills nothing and leaves the worker with a fresh core.
    await extension.clickMenuItem(tab);
    let badge = await extension.badgeOf(tab.id);
    if (badge.text === "!") {
      assert.equal(
        badge.title,
        extension.message(
          "fillGenerateFailed",
          "The generator core stopped unexpectedly. Try again.",
        ),
      );
      assert.deepEqual(await values(page, "pw", "pw2"), [first, first]);
      await extension.clickMenuItem(tab);
      badge = await extension.badgeOf(tab.id);
    }
    assert.deepEqual(badge, okBadge("fillOkConfirm"));
    const [pw, pw2] = await values(page, "pw", "pw2");
    assert.match(pw, PASSWORD);
    assert.notEqual(pw, first);
    assert.equal(pw2, pw);
  });

  test("the badge and the tooltip clear themselves", TIMEOUT, async () => {
    const { page, tab } = await extension.openFixture("signup.html");
    await page.locator("#pw").click();
    await extension.clickMenuItem(tab);
    assert.deepEqual(await extension.badgeOf(tab.id), okBadge("fillOkConfirm"));
    const cleared = await until(
      "the badge to clear",
      () => extension.badgeOf(tab.id),
      (badge) => badge.text === "",
      8000,
    );
    assert.deepEqual(cleared, { text: "", title: extension.message("actionTitle") });
    // Badge and tooltip belong to the tab that was filled, no other.
    const other = await extension.openFixture("blank.html");
    await extension.clickMenuItem(tab);
    assert.equal((await extension.badgeOf(tab.id)).text, "OK");
    assert.deepEqual(await extension.badgeOf(other.tab.id), {
      text: "",
      title: extension.message("actionTitle"),
    });
  });

  test(
    "the menu item exists exactly once, also after onInstalled and onStartup ran again",
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

      // There is no API that lists menu items. The calls that make them are
      // recorded instead, while the two events that lead to them are
      // delivered again: one after the other, as on an update and on a later
      // browser start, and then both at once, as on a browser update.
      const calls = await extension.worker().evaluate(async () => {
        const calls = [];
        const menus = chrome.contextMenus;
        const original = { create: menus.create, removeAll: menus.removeAll };
        let settled = () => {};
        menus.removeAll = (callback) => {
          calls.push({ call: "removeAll" });
          return original.removeAll.call(menus, callback);
        };
        menus.create = (properties, callback) => {
          const entry = { call: "create", properties, error: "pending" };
          calls.push(entry);
          return original.create.call(menus, properties, () => {
            entry.error = chrome.runtime.lastError?.message ?? null;
            callback?.();
            settled();
          });
        };
        const created = (count) =>
          new Promise((resolve) => {
            settled = () => {
              const done = calls.filter(
                (entry) => entry.call === "create" && entry.error !== "pending",
              );
              if (done.length >= count) resolve();
            };
          });
        try {
          let done = created(1);
          chrome.runtime.onInstalled.dispatch({ reason: "update", previousVersion: "2.0.0" });
          await done;
          done = created(2);
          chrome.runtime.onStartup.dispatch();
          await done;
          done = created(4);
          chrome.runtime.onInstalled.dispatch({ reason: "chrome_update" });
          chrome.runtime.onStartup.dispatch();
          await done;
        } finally {
          menus.create = original.create;
          menus.removeAll = original.removeAll;
        }
        return calls;
      });

      const creates = calls.filter((entry) => entry.call === "create");
      assert.equal(creates.length, 4, "one item per event");
      for (const create of creates) {
        assert.deepEqual(create.properties, {
          id: MENU_ID,
          title: extension.message("menuFillPassword"),
          contexts: ["editable"],
          documentUrlPatterns: ["http://*/*", "https://*/*", "file:///*"],
        });
      }
      // Everything is removed before an item is made, so no event adds a
      // second one. Run one after the other, each event leaves exactly one.
      assert.deepEqual(
        calls.slice(0, 4).map((entry) => `${entry.call}${entry.error ? `: ${entry.error}` : ""}`),
        ["removeAll", "create", "removeAll", "create"],
      );
      // Run at once, the second create meets the item of the first. The
      // browser refuses the duplicate, which is the wanted outcome.
      assert.deepEqual(
        calls.slice(4).map((entry) => entry.call),
        ["removeAll", "removeAll", "create", "create"],
      );
      assert.equal(calls[6].error, null);
      assert.match(calls[7].error, /duplicate id fill-password/);
      assert.equal(await exists(), true);

      // One item with this id: once removed, it is gone. Put back the way
      // the browser would, for the tests that follow.
      const removedThenExists = await extension.worker().evaluate(
        (id) =>
          new Promise((resolve) => {
            chrome.contextMenus.remove(id, () => {
              const removed = !chrome.runtime.lastError;
              chrome.contextMenus.update(id, {}, () =>
                resolve([removed, !chrome.runtime.lastError]),
              );
            });
          }),
        MENU_ID,
      );
      assert.deepEqual(removedThenExists, [true, false]);
      await extension.worker().evaluate(() => {
        chrome.runtime.onInstalled.dispatch({ reason: "update" });
      });
      await until("the menu item to be back", exists);
    },
  );

  // The last two look back at everything the tests above did.
  test("no generated value was stored, and nothing but options and notices", TIMEOUT, async () => {
    // Leave settings behind, as a user's last popup would.
    const popup = await extension.openPopup();
    await popup.page.locator("#tab-secret").click();
    await until(
      "the tab to be saved",
      async () => (await extension.storage()).local["settings.v1"]?.tab,
      (tab) => tab === "secret",
    );

    const storage = await extension.storage();
    assert.deepEqual(Object.keys(storage.local), ["settings.v1"]);
    assert.deepEqual(
      Object.keys(storage.session).filter((key) => key !== "notice.v1"),
      [],
      "storage.session holds nothing but a notice",
    );

    const changes = await extension.storageChanges();
    assert.deepEqual([...new Set(changes.map((change) => `${change.area}:${change.key}`))].sort(), [
      "local:settings.v1",
      "session:notice.v1",
    ]);
    // A notice is a time and a sentence, nothing else.
    const notices = changes.filter((change) => change.key === "notice.v1" && change.value);
    assert.ok(notices.length >= 5, "the tests above left notices");
    for (const notice of notices) {
      assert.deepEqual(Object.keys(notice.value).sort(), ["at", "message"]);
      assert.equal(typeof notice.value.at, "number");
      assert.equal(typeof notice.value.message, "string");
    }

    assert.ok(generated.size >= 15, `the tests above generate values (${generated.size})`);
    const tabs = await extension.worker().evaluate(() => chrome.tabs.query({}));
    const haystack = JSON.stringify([storage, changes, tabs]);
    for (const value of generated) {
      assert.equal(haystack.includes(value), false, "a generated value left the page");
    }
  });

  test("the extension logged no errors", TIMEOUT, async () => {
    const log = await extensionErrors();
    assert.equal(log.collecting, true);
    assert.deepEqual(log.manifestErrors, []);
    assert.deepEqual(log.installWarnings, []);
    assert.deepEqual(log.runtimeErrors, []);

    // The empty list above means something only if the log records. An
    // error made on purpose shows that it does.
    await extension.worker().evaluate((id) => {
      chrome.contextMenus.create({ id, title: "duplicate", contexts: ["editable"] });
    }, MENU_ID);
    const recorded = await until(
      "the error to be recorded",
      async () => (await extensionErrors()).runtimeErrors,
      (errors) => errors.length > 0,
    );
    assert.equal(recorded.length, 1, JSON.stringify(recorded));
    assert.match(recorded[0], /duplicate id fill-password/);
  });
});
