// The popup's "Fill in page" button against the fixture pages: which field
// gets the value, which fields are left alone, what the page hears of it
// and what the popup says when it cannot fill.
//
// The popup is open in a tab and pointed at the fixture with ?tabId=. For
// every fill the fixture is put into the state a real popup leaves a page
// in, without the window focus: see fillFromPopup() in helpers.mjs.
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { fillFromPopup, launchExtension, nextStatus, until } from "./helpers.mjs";

const TIMEOUT = { timeout: 60_000 };
const PASSWORD = /^[A-Za-z0-9]{20}$/;

describe("Fill in page, from the popup", () => {
  let extension;
  // Every value a popup showed. None of them may turn up in storage.
  const shown = new Set();

  /** A popup pointed at the tab of `fixture`, and the value it shows. */
  async function popupFor(fixture) {
    const popup = await extension.openPopup(`?tabId=${fixture.tab.id}`);
    assert.equal(await popup.page.locator("#btn-fill").isEnabled(), true);
    assert.equal(await popup.page.locator("#fill-hint").isHidden(), true);
    return { popup, value: await valueOf(popup) };
  }

  async function valueOf(popup) {
    const value = await popup.page.locator("#output").textContent();
    assert.notEqual(value, "");
    shown.add(value);
    return value;
  }

  /** Makes the popup show another value and returns it. */
  async function regenerate(popup) {
    const before = await popup.page.locator("#output").textContent();
    await popup.page.locator("#btn-generate").click();
    await until(
      "a new value",
      () => popup.page.locator("#output").textContent(),
      (value) => value !== "" && value !== before,
    );
    return valueOf(popup);
  }

  /** The values of fields of a page or frame, by id. */
  const values = (scope, ...ids) =>
    Promise.all(ids.map((id) => scope.locator(`#${id}`).inputValue()));

  const ok = (key) => ({ state: "ok", text: extension.message(key) });
  const bad = (key, ...substitutions) => ({
    state: "bad",
    text: extension.message(key, ...substitutions),
  });

  before(async () => {
    extension = await launchExtension();
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

  test(
    "fills the focused password field and its confirmation in the same form",
    TIMEOUT,
    async () => {
      const fixture = await extension.openFixture("signup.html");
      await fixture.page.locator("#pw").click();
      const { popup, value } = await popupFor(fixture);
      assert.match(value, PASSWORD);

      assert.deepEqual(await fillFromPopup(extension, popup, fixture.page), ok("fillOkConfirm"));
      assert.deepEqual(await values(fixture.page, "pw", "pw2"), [value, value]);
      assert.deepEqual(await values(fixture.page, "user", "note", "comment"), ["", "", ""]);
      // The fill wrote into the page and did nothing else to it.
      assert.equal(await fixture.page.evaluate(() => document.activeElement.id), "pw");
      assert.equal(await popup.page.locator("#output").textContent(), value);
    },
  );

  test("the page hears the fill as input and change events that bubble", TIMEOUT, async () => {
    const fixture = await extension.openFixture("signup.html");
    await fixture.page.locator("#pw").click();
    const { popup, value } = await popupFor(fixture);
    assert.deepEqual(await fillFromPopup(extension, popup, fixture.page), ok("fillOkConfirm"));

    // Listeners on the document saw these: each one bubbled up to it.
    // Only events made by a script are recorded, see fixtures/events.js.
    const events = await fixture.page.evaluate(() => window.fixtureEvents);
    const of = (field) => events.filter((event) => event.field === field);
    assert.deepEqual(
      of("pw").map((event) => event.type),
      ["keydown", "input", "change", "keyup"],
    );
    // The confirmation never had the focus, so it is given one for the
    // length of the fill: validation that runs on blur has to see it.
    assert.deepEqual(
      of("pw2").map((event) => event.type),
      ["focusin", "keydown", "input", "change", "keyup", "focusout"],
    );
    assert.deepEqual(
      events.filter((event) => !["pw", "pw2"].includes(event.field)),
      [],
      "no other element was touched",
    );
    for (const field of ["pw", "pw2"]) {
      const input = of(field).find((event) => event.type === "input");
      assert.deepEqual(input, {
        type: "input",
        field,
        bubbles: true,
        composed: true,
        inputType: "insertReplacementText",
        // The value is in the field before anyone is told about it.
        value,
      });
      const change = of(field).find((event) => event.type === "change");
      assert.equal(change.bubbles, true);
      assert.equal(change.value, value);
    }
  });

  test(
    "a second fill replaces both fields, but not a confirmation the user typed",
    TIMEOUT,
    async () => {
      const fixture = await extension.openFixture("signup.html");
      await fixture.page.locator("#pw").click();
      const { popup, value } = await popupFor(fixture);
      assert.deepEqual(await fillFromPopup(extension, popup, fixture.page), ok("fillOkConfirm"));

      const second = await regenerate(popup);
      assert.notEqual(second, value);
      assert.deepEqual(await fillFromPopup(extension, popup, fixture.page), ok("fillOkConfirm"));
      assert.deepEqual(
        await values(fixture.page, "pw", "pw2"),
        [second, second],
        "the confirmation must not keep the first password",
      );

      await fixture.page.locator("#pw2").fill("typed by the user");
      await fixture.page.locator("#pw").focus();
      const third = await regenerate(popup);
      assert.deepEqual(await fillFromPopup(extension, popup, fixture.page), ok("fillOk"));
      assert.deepEqual(await values(fixture.page, "pw", "pw2"), [third, "typed by the user"]);
    },
  );

  test(
    "a text field or a textarea gets the value of any tab, and only that field",
    TIMEOUT,
    async () => {
      const fixture = await extension.openFixture("signup.html");
      await fixture.page.locator("#note").click();
      const { popup, value } = await popupFor(fixture);
      assert.deepEqual(await fillFromPopup(extension, popup, fixture.page), ok("fillOk"));
      assert.deepEqual(await values(fixture.page, "note", "user", "pw", "pw2"), [
        value,
        "",
        "",
        "",
      ]);

      await popup.page.locator("#tab-passphrase").click();
      const passphrase = await until(
        "a passphrase",
        () => popup.page.locator("#output").textContent(),
        (shown) => shown.includes("-"),
      );
      shown.add(passphrase);
      await fixture.page.locator("#comment").focus();
      assert.deepEqual(await fillFromPopup(extension, popup, fixture.page), ok("fillOk"));
      assert.deepEqual(await values(fixture.page, "comment", "note"), [passphrase, value]);

      // A text field inside a form is not taken for a password field: the
      // password fields after it stay empty.
      await fixture.page.locator("#user").focus();
      assert.deepEqual(await fillFromPopup(extension, popup, fixture.page), ok("fillOk"));
      assert.deepEqual(await values(fixture.page, "user", "pw", "pw2"), [passphrase, "", ""]);
    },
  );

  test("a field in a same-origin frame is filled", TIMEOUT, async () => {
    const fixture = await extension.openFixture("frame.html?src=/signup.html");
    const frame = fixture.page.frameLocator("#frame");
    await frame.locator("#pw").click();
    const { popup, value } = await popupFor(fixture);
    assert.deepEqual(await fillFromPopup(extension, popup, fixture.page), ok("fillOkConfirm"));
    assert.deepEqual(await values(frame, "pw", "pw2", "user"), [value, value, ""]);

    // The events are made in the frame's own window and arrive there.
    const heard = await fixture.page
      .frames()[1]
      .evaluate(() => window.fixtureEvents.filter((event) => event.type === "input").length);
    assert.equal(heard, 2);
  });

  test("a field inside an open shadow root is filled", TIMEOUT, async () => {
    const fixture = await extension.openFixture("shadow.html");
    // Playwright's selectors reach into open shadow roots.
    await fixture.page.locator("login-box #pw").click();
    assert.equal(
      await fixture.page.evaluate(() => document.activeElement.localName),
      "login-box",
      "from outside, the focus is on the component",
    );
    const { popup, value } = await popupFor(fixture);
    assert.deepEqual(await fillFromPopup(extension, popup, fixture.page), ok("fillOkConfirm"));
    assert.deepEqual(await values(fixture.page.locator("login-box"), "pw", "pw2"), [value, value]);

    // "input" is composed and leaves the shadow tree; "change" is not,
    // just like the one a browser fires, and stays inside.
    const heard = await fixture.page.evaluate(() => ({
      atDocument: window.fixtureEvents
        .filter((event) => event.type === "input" || event.type === "change")
        .map((event) => `${event.type} ${event.field} composed=${event.composed}`),
      insideRoot: window.shadowChanges,
    }));
    assert.deepEqual(heard, {
      atDocument: ["input pw composed=true", "input pw2 composed=true"],
      insideRoot: [
        { field: "pw", bubbles: true },
        { field: "pw2", bubbles: true },
      ],
    });
  });

  test("the focus is followed through a frame into a shadow root", TIMEOUT, async () => {
    const fixture = await extension.openFixture("frame.html?src=/shadow.html");
    const box = fixture.page.frameLocator("#frame").locator("login-box");
    await box.locator("#pw").click();
    const { popup, value } = await popupFor(fixture);
    assert.deepEqual(await fillFromPopup(extension, popup, fixture.page), ok("fillOkConfirm"));
    assert.deepEqual(await values(box, "pw", "pw2"), [value, value]);
  });

  test("a value longer than the field's maxlength is refused with the limit", TIMEOUT, async () => {
    const fixture = await extension.openFixture("limits.html");
    await fixture.page.locator("#pw8").click();
    const { popup } = await popupFor(fixture);
    assert.deepEqual(await fillFromPopup(extension, popup, fixture.page), bad("fillTooLong", "8"));
    assert.deepEqual(await values(fixture.page, "pw8", "pw8-confirm"), ["", ""]);

    await fixture.page.locator("#pw16").focus();
    assert.deepEqual(await fillFromPopup(extension, popup, fixture.page), bad("fillTooLong", "16"));
    assert.deepEqual(await values(fixture.page, "pw16", "pw16-confirm"), ["", ""]);

    // What the message asks for: a shorter value from the popup.
    await popup.page.locator("#pw-length").fill("16");
    const shorter = await until(
      "a 16-character password",
      () => popup.page.locator("#output").textContent(),
      (value) => value.length === 16,
    );
    shown.add(shorter);
    assert.deepEqual(await fillFromPopup(extension, popup, fixture.page), ok("fillOkConfirm"));
    assert.deepEqual(await values(fixture.page, "pw16", "pw16-confirm"), [shorter, shorter]);
  });

  test("a field in a frame from another origin is refused as out of reach", TIMEOUT, async () => {
    const src = `${extension.foreignOrigin}/signup.html`;
    const fixture = await extension.openFixture(`frame.html?src=${encodeURIComponent(src)}`);
    const frame = fixture.page.frameLocator("#frame");
    await frame.locator("#pw").click();
    assert.equal(
      await fixture.page.evaluate(() => document.activeElement.id),
      "frame",
      "the focus is inside the frame",
    );
    const { popup } = await popupFor(fixture);
    assert.deepEqual(await fillFromPopup(extension, popup, fixture.page), bad("fillCrossOrigin"));
    assert.deepEqual(await values(frame, "pw", "pw2", "user"), ["", "", ""]);
  });

  test(
    "without a focused field nothing is filled and the popup says what to do",
    TIMEOUT,
    async () => {
      const fixture = await extension.openFixture("signup.html");
      assert.equal(await fixture.page.evaluate(() => document.activeElement.localName), "body");
      const { popup } = await popupFor(fixture);
      assert.deepEqual(await fillFromPopup(extension, popup, fixture.page), bad("fillNoField"));

      // Something has the focus, but it is not a field for text.
      await fixture.page.locator("#submit").focus();
      assert.deepEqual(await fillFromPopup(extension, popup, fixture.page), bad("fillNoField"));
      assert.deepEqual(await values(fixture.page, "user", "pw", "pw2", "note", "comment"), [
        "",
        "",
        "",
        "",
        "",
      ]);

      const other = await extension.openFixture("refusals.html");
      await other.page.locator("#checkbox").focus();
      const second = await popupFor(other);
      assert.deepEqual(
        await fillFromPopup(extension, second.popup, other.page),
        bad("fillNoField"),
      );
      assert.equal(await other.page.locator("#checkbox").isChecked(), false);
    },
  );

  test("a read-only field and an invisible field are refused", TIMEOUT, async () => {
    const fixture = await extension.openFixture("refusals.html");
    await fixture.page.locator("#readonly").focus();
    const { popup } = await popupFor(fixture);
    assert.deepEqual(await fillFromPopup(extension, popup, fixture.page), bad("fillReadOnly"));

    // A page could move the focus to a field nobody can see.
    await fixture.page.locator("#transparent").focus();
    assert.equal(await fixture.page.evaluate(() => document.activeElement.id), "transparent");
    assert.deepEqual(await fillFromPopup(extension, popup, fixture.page), bad("fillHidden"));
    assert.deepEqual(await values(fixture.page, "readonly", "transparent"), ["", ""]);
    assert.deepEqual(
      await fixture.page.evaluate(() => window.fixtureEvents),
      [],
      "no events either",
    );
  });

  test("a number field takes a PIN and nothing else", TIMEOUT, async () => {
    const fixture = await extension.openFixture("refusals.html");
    await fixture.page.locator("#number").click();
    const { popup } = await popupFor(fixture);
    // A browser empties a number field that is given letters, and the
    // page would get an empty value behind a success message.
    assert.deepEqual(await fillFromPopup(extension, popup, fixture.page), bad("fillNoField"));
    assert.deepEqual(await values(fixture.page, "number"), [""]);

    await popup.page.locator("#tab-pin").click();
    await popup.page.locator("#pin-ack").check();
    const pin = await until(
      "a PIN",
      () => popup.page.locator("#output").textContent(),
      (value) => /^[0-9]{6}$/.test(value),
    );
    shown.add(pin);
    assert.deepEqual(await fillFromPopup(extension, popup, fixture.page), ok("fillOk"));
    assert.deepEqual(await values(fixture.page, "number"), [pin]);
  });

  test(
    "a tab that is gone by the time Fill is pressed is reported as blocked",
    TIMEOUT,
    async () => {
      const fixture = await extension.openFixture("signup.html");
      await fixture.page.locator("#pw").click();
      const { popup } = await popupFor(fixture);
      await fixture.page.close();
      const status = await nextStatus(popup.page, () => popup.page.locator("#btn-fill").click());
      assert.deepEqual(status, bad("fillBlocked"));
    },
  );

  test(
    "a page that rewrites the value is reported, not passed off as filled",
    TIMEOUT,
    async () => {
      const fixture = await extension.openFixture("refusals.html");
      await fixture.page.locator("#uppercase").click();
      const { popup, value } = await popupFor(fixture);
      assert.match(value, /[a-z]/, "the default settings require a lowercase letter");
      assert.deepEqual(await fillFromPopup(extension, popup, fixture.page), ok("fillModified"));
      assert.deepEqual(await values(fixture.page, "uppercase"), [value.toUpperCase()]);
    },
  );

  test("a password field outside any form does not drag another one along", TIMEOUT, async () => {
    const fixture = await extension.openFixture("standalone.html");
    await fixture.page.locator("#loose").click();
    const { popup, value } = await popupFor(fixture);
    assert.deepEqual(await fillFromPopup(extension, popup, fixture.page), ok("fillOk"));
    assert.deepEqual(await values(fixture.page, "loose", "neighbour", "in-form"), [value, "", ""]);

    // Nor does the last password field of a form reach beyond the form.
    const second = await regenerate(popup);
    await fixture.page.locator("#in-form").focus();
    assert.deepEqual(await fillFromPopup(extension, popup, fixture.page), ok("fillOk"));
    assert.deepEqual(await values(fixture.page, "loose", "neighbour", "in-form"), [
      value,
      "",
      second,
    ]);
  });

  test(
    "in a change-password form, the new password and its confirmation are filled",
    TIMEOUT,
    async () => {
      const fixture = await extension.openFixture("change-password.html");
      // A field marked as the current password is one field, not the first
      // of two: the empty field after it is not its confirmation.
      await fixture.page.locator("#current").click();
      const { popup, value } = await popupFor(fixture);
      assert.deepEqual(await fillFromPopup(extension, popup, fixture.page), ok("fillOk"));
      assert.deepEqual(await values(fixture.page, "current", "new", "confirm"), [value, "", ""]);

      // From the new password on, the field and the one after it are
      // filled. The field before it is never written.
      await fixture.page.locator("#current").fill("the old password");
      await fixture.page.locator("#new").focus();
      const second = await regenerate(popup);
      assert.deepEqual(await fillFromPopup(extension, popup, fixture.page), ok("fillOkConfirm"));
      assert.deepEqual(await values(fixture.page, "current", "new", "confirm"), [
        "the old password",
        second,
        second,
      ]);

      // The same form without autocomplete hints, as many sites write it.
      await fixture.page.locator("#bare-new").focus();
      assert.deepEqual(await fillFromPopup(extension, popup, fixture.page), ok("fillOkConfirm"));
      assert.deepEqual(await values(fixture.page, "bare-current", "bare-new", "bare-confirm"), [
        "",
        second,
        second,
      ]);
    },
  );

  // 127.0.0.1 counts as a secure context even over http, so this page is
  // reached under a name that does not.
  test("a page that is not served over HTTPS is filled with a warning", TIMEOUT, async () => {
    const fixture = await extension.openFixture("signup.html", {
      origin: extension.plainHttpOrigin,
    });
    assert.equal(await fixture.page.evaluate(() => isSecureContext), false);
    await fixture.page.locator("#pw").click();
    const { popup, value } = await popupFor(fixture);
    const status = await fillFromPopup(extension, popup, fixture.page);
    assert.deepEqual(status, {
      state: "ok",
      text: `${extension.message("fillOkConfirm")} ${extension.message("popupFillInsecure")}`,
    });
    assert.equal(
      await popup.page.locator("#status .status-warning").textContent(),
      extension.message("popupFillInsecure"),
    );
    assert.deepEqual(await values(fixture.page, "pw", "pw2"), [value, value]);
  });

  // Last on purpose: it looks back at everything the tests above did.
  test("no value that was filled is in the extension's storage", TIMEOUT, async () => {
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
    assert.deepEqual(Object.keys(storage.session), []);
    const changes = await extension.storageChanges();
    assert.deepEqual(
      [...new Set(changes.map((change) => `${change.area}:${change.key}`))],
      ["local:settings.v1"],
      "every write went to the options",
    );
    assert.ok(shown.size >= 15, `the tests above filled values (${shown.size})`);
    const haystack = JSON.stringify([storage, changes]);
    for (const value of shown) {
      assert.equal(haystack.includes(value), false, "a filled value was stored");
    }
  });
});
