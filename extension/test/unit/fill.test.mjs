// fillFocusedField is handed to chrome.scripting.executeScript, which
// sends its source text to the page and compiles it there. Anything it
// took from module scope would be undefined in the page, and Chrome
// reports that only as a null result. So the function is rebuilt here from
// its text alone, in a context that has nothing but stand-ins for the
// page's own globals.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import vm from "node:vm";
import { importBuilt } from "./helpers.mjs";

const { fillFocusedField } = await importBuilt("lib/fill.js");
const source = fillFocusedField.toString();

const VALUE = "Xk3mQ9vT2pLw8ZrB5nYc";
const OTHER_VALUE = "b7Hq2WnE9sKd4TxV6mPa";

class FakeEvent {
  constructor(type) {
    this.type = type;
  }
}

/** Just enough of a page for the function to find and write one field. */
function page({ secure = true } = {}) {
  class Document {
    get activeElement() {
      return this.focused;
    }
  }
  class HTMLInputElement {
    get value() {
      return this.current;
    }
    set value(next) {
      this.current = String(next);
    }
  }
  class HTMLTextAreaElement extends HTMLInputElement {}
  const window = {
    isSecureContext: secure,
    HTMLInputElement,
    HTMLTextAreaElement,
    Event: FakeEvent,
    FocusEvent: FakeEvent,
    InputEvent: FakeEvent,
    KeyboardEvent: FakeEvent,
  };
  const document = Object.assign(new Document(), {
    nodeType: 9,
    focused: null,
    defaultView: window,
  });

  const input = (properties = {}) =>
    Object.assign(new HTMLInputElement(), {
      localName: "input",
      type: "password",
      current: "",
      disabled: false,
      readOnly: false,
      maxLength: -1,
      form: null,
      shadowRoot: null,
      ownerDocument: document,
      events: [],
      getAttribute: () => null,
      checkVisibility: () => true,
      dispatchEvent(event) {
        this.events.push(event.type);
        return true;
      },
      ...properties,
    });

  // The Function constructor of the new context compiles in that context:
  // free identifiers resolve against its globals and nothing else.
  const context = vm.createContext({ document, Document, window });
  // V8 puts a console into every context. The injected function must not
  // log, so take it away and let a stray call fail the tests.
  vm.runInContext("delete globalThis.console", context);
  const ContextFunction = vm.runInContext("Function", context);
  const fill = new ContextFunction(`return (${source})`)();
  return {
    context,
    document,
    input,
    // Results are created in the other context; copying them gives plain
    // objects that deepEqual can compare.
    fill: (value, mode) => ({ ...fill(value, mode) }),
  };
}

test("the test context has none of the extension's or Node's globals", () => {
  const { context } = page();
  const types = vm.runInContext(
    "[typeof chrome, typeof console, typeof process, typeof require]",
    context,
  );
  assert.deepEqual([...types], ["undefined", "undefined", "undefined", "undefined"]);
});

describe("fillFocusedField rebuilt from its source text", () => {
  test("reports no-field when nothing is focused", () => {
    for (const mode of ["menu", "popup", "command"]) {
      assert.deepEqual(page().fill(VALUE, mode), { filled: 0, reason: "no-field" });
    }
  });

  test("reports no-field when the focused element is not a text field", () => {
    const { document, fill } = page();
    document.focused = { localName: "body", shadowRoot: null };
    assert.deepEqual(fill(VALUE, "popup"), { filled: 0, reason: "no-field" });
  });

  // The write path uses helpers that the early returns above never reach.
  test("fills a focused password field", () => {
    for (const mode of ["menu", "popup", "command"]) {
      const { document, input, fill } = page();
      const field = (document.focused = input());
      assert.deepEqual(fill(VALUE, mode), { filled: 1 });
      assert.equal(field.value, VALUE);
      assert.ok(field.events.includes("input"));
      assert.ok(field.events.includes("change"));
    }
  });

  test("fills the confirmation field that follows in the same form", () => {
    const { document, input, fill } = page();
    const form = { elements: [] };
    const field = input({ form });
    const confirm = input({ form });
    form.elements.push(input({ type: "text", form }), field, confirm);
    document.focused = field;
    assert.deepEqual(fill(VALUE, "menu"), { filled: 2 });
    assert.equal(confirm.value, VALUE);
    assert.equal(form.elements[0].value, "");
  });

  // A second fill of the same form (Regenerate then Fill, a shortcut pressed
  // twice) must not leave the first password in the confirmation field.
  test("a repeated fill replaces a confirmation that mirrors the field", () => {
    const { document, input, fill } = page();
    const form = { elements: [] };
    const field = input({ form });
    const confirm = input({ form });
    form.elements.push(field, confirm);
    document.focused = field;
    assert.deepEqual(fill(VALUE, "menu"), { filled: 2 });
    assert.deepEqual(fill(OTHER_VALUE, "menu"), { filled: 2 });
    assert.equal(field.value, OTHER_VALUE);
    assert.equal(confirm.value, OTHER_VALUE);
  });

  test("fills an empty confirmation when the field already held a value", () => {
    const { document, input, fill } = page();
    const form = { elements: [] };
    const field = input({ form, current: "typed-by-hand" });
    const confirm = input({ form });
    form.elements.push(field, confirm);
    document.focused = field;
    assert.deepEqual(fill(VALUE, "popup"), { filled: 2 });
    assert.equal(confirm.value, VALUE);
  });

  test("leaves a confirmation alone that holds something else", () => {
    const { document, input, fill } = page();
    const form = { elements: [] };
    const field = input({ form });
    const confirm = input({ form, current: "typed-by-hand" });
    form.elements.push(field, confirm);
    document.focused = field;
    assert.deepEqual(fill(VALUE, "menu"), { filled: 1 });
    assert.equal(field.value, VALUE);
    assert.equal(confirm.value, "typed-by-hand");
    assert.deepEqual(confirm.events, []);
  });

  test("the shortcut refuses a field that is not a password field", () => {
    const { document, input, fill } = page();
    const field = (document.focused = input({ type: "text" }));
    assert.deepEqual(fill(VALUE, "command"), { filled: 0, reason: "not-password" });
    assert.equal(field.value, "");
    assert.deepEqual(field.events, []);
  });

  test("refuses a value longer than maxlength and reports the limit", () => {
    const { document, input, fill } = page();
    const field = (document.focused = input({ maxLength: 8 }));
    assert.deepEqual(fill(VALUE, "menu"), { filled: 0, reason: "too-long", maxLength: 8 });
    assert.equal(field.value, "");
  });

  test("refuses read-only and hidden fields", () => {
    const first = page();
    first.document.focused = first.input({ readOnly: true });
    assert.deepEqual(first.fill(VALUE, "menu"), { filled: 0, reason: "read-only" });
    const second = page();
    second.document.focused = second.input({ checkVisibility: () => false });
    assert.deepEqual(second.fill(VALUE, "menu"), { filled: 0, reason: "hidden" });
  });

  test("flags a page that is not a secure context", () => {
    const { document, input, fill } = page({ secure: false });
    document.focused = input();
    assert.deepEqual(fill(VALUE, "popup"), { filled: 1, insecure: true });
  });

  // The result travels back to the extension through the browser; the
  // value must not travel with it.
  test("never returns the value", () => {
    const { document, input, fill } = page();
    document.focused = input();
    assert.equal(JSON.stringify(fill(VALUE, "popup")).includes(VALUE), false);
    const refused = page();
    refused.document.focused = refused.input({ maxLength: 4 });
    assert.equal(JSON.stringify(refused.fill(VALUE, "popup")).includes(VALUE), false);
  });
});
