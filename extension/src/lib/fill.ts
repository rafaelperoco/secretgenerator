// Injected into the page with chrome.scripting.executeScript. The function
// is serialized with toString(), so it MUST be self-contained: no imports,
// no module-scope helpers, no closure variables. test/fill-selfcontained
// enforces that.
//
// It runs in the extension's ISOLATED world: page scripts cannot tamper
// with it, and it never returns or logs the value it was given.

/**
 * How the fill was triggered. It decides how strict the target check is:
 *  - "menu":    the user right-clicked this field. Injected into that frame.
 *  - "popup":   the user pressed Fill in the popup. Injected into the top frame.
 *  - "command": keyboard shortcut. Blind, so it only fills password fields;
 *               a page that moves focus must not get a secret on screen.
 */
export type FillMode = "menu" | "popup" | "command";

export type FillReason =
  | "no-field" // nothing focused, or the focused element is not a text field
  | "cross-origin-frame" // focus is inside a frame activeTab cannot reach
  | "not-password" // command mode only fills input[type=password]
  | "read-only"
  | "hidden"
  | "too-long" // value exceeds the field's maxlength; see maxLength
  | "error";

export type FillResult = {
  /** Number of fields written: 0, 1, or 2 (field plus its confirmation). */
  filled: number;
  reason?: FillReason;
  /** The field's maxlength, when reason is "too-long". */
  maxLength?: number;
  /** The page changed or rejected the value after it was set. */
  modified?: boolean;
  /** The page is not a secure context (plain http). */
  insecure?: boolean;
};

export function fillFocusedField(value: string, mode: FillMode): FillResult {
  try {
    // Markup such as <form name="activeElement"> shadows document
    // properties. Reading through the prototype getter is immune to that.
    const docActive = Object.getOwnPropertyDescriptor(Document.prototype, "activeElement")?.get;
    const activeOf = (root: Document | ShadowRoot): Element | null =>
      root.nodeType === 9 && docActive
        ? (docActive.call(root) as Element | null)
        : root.activeElement;

    // Follow focus through open shadow roots and same-origin iframes. This
    // works while the extension popup holds window focus, unlike
    // document.hasFocus(), because each document remembers its own
    // activeElement.
    let el: Element | null = activeOf(document);
    for (let depth = 0; el && depth < 32; depth++) {
      const name = el.localName;
      if (name === "iframe" || name === "frame") {
        let inner: Document | null = null;
        try {
          inner = (el as HTMLIFrameElement).contentDocument;
        } catch {
          inner = null;
        }
        if (!inner) return { filled: 0, reason: "cross-origin-frame" };
        el = activeOf(inner);
        continue;
      }
      const shadow: ShadowRoot | null = el.shadowRoot;
      if (shadow && shadow.activeElement) {
        el = activeOf(shadow);
        continue;
      }
      break;
    }
    if (!el) return { filled: 0, reason: "no-field" };

    type Field = HTMLInputElement | HTMLTextAreaElement;
    const kindOf = (e: Element): string =>
      e.localName === "textarea"
        ? "textarea"
        : e.localName === "input"
          ? (e as HTMLInputElement).type
          : "";
    const kind = kindOf(el);
    const textKinds = ["password", "text", "textarea", "search", "tel", "url", "email"];
    const numeric = kind === "number" && /^[0-9]+$/.test(value);
    if (!textKinds.includes(kind) && !numeric) return { filled: 0, reason: "no-field" };
    if (mode === "command" && kind !== "password") return { filled: 0, reason: "not-password" };

    const field = el as Field;
    const visible = (e: Element): boolean =>
      typeof e.checkVisibility !== "function" ||
      e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    const tooLong = (f: Field): boolean => f.maxLength > 0 && value.length > f.maxLength;
    const autocomplete = (f: Field): string => (f.getAttribute("autocomplete") ?? "").toLowerCase();

    if (field.disabled || field.readOnly) return { filled: 0, reason: "read-only" };
    if (!visible(field)) return { filled: 0, reason: "hidden" };
    // Script-set values bypass maxlength: the DOM would hold the full value
    // and the site would truncate or reject it server-side. Refuse instead.
    if (tooLong(field)) return { filled: 0, reason: "too-long", maxLength: field.maxLength };

    // Mirrors what browsers' own autofill dispatches so framework-bound
    // inputs (React, Vue, Angular, Svelte) register the change. Constructors
    // come from the field's own window: it may live in a child frame.
    const write = (target: Field, simulateFocus: boolean): boolean => {
      const view = target.ownerDocument.defaultView ?? window;
      const proto =
        target.localName === "textarea"
          ? view.HTMLTextAreaElement.prototype
          : view.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      const key = { bubbles: true, cancelable: true, composed: true, key: "Unidentified" };
      if (simulateFocus) {
        target.dispatchEvent(new view.FocusEvent("focus", { composed: true }));
        target.dispatchEvent(new view.FocusEvent("focusin", { bubbles: true, composed: true }));
      }
      target.dispatchEvent(new view.KeyboardEvent("keydown", key));
      if (setter) setter.call(target, value);
      else target.value = value;
      target.dispatchEvent(
        new view.InputEvent("input", {
          bubbles: true,
          composed: true,
          inputType: "insertReplacementText",
        }),
      );
      target.dispatchEvent(new view.Event("change", { bubbles: true }));
      target.dispatchEvent(new view.KeyboardEvent("keyup", key));
      if (simulateFocus) {
        target.dispatchEvent(new view.FocusEvent("blur", { composed: true }));
        target.dispatchEvent(new view.FocusEvent("focusout", { bubbles: true, composed: true }));
      }
      return target.value === value;
    };

    let intact = write(field, false);
    let filled = 1;

    // Sign-up forms ask for a new password twice. Fill the password field
    // that directly follows in the same <form>, and only there: without a
    // form there is no safe way to tell a confirmation from an unrelated
    // field elsewhere on the page.
    const form = field.form;
    if (kind === "password" && form && !autocomplete(field).includes("current-password")) {
      const passwords = Array.from(form.elements).filter(
        (e) => kindOf(e) === "password",
      ) as HTMLInputElement[];
      const index = passwords.indexOf(field as HTMLInputElement);
      const next = index >= 0 ? passwords[index + 1] : undefined;
      if (
        next &&
        !next.value &&
        !next.disabled &&
        !next.readOnly &&
        visible(next) &&
        !tooLong(next) &&
        !/current-password|one-time-code/.test(autocomplete(next))
      ) {
        intact = write(next, true) && intact;
        filled = 2;
      }
    }

    const result: FillResult = { filled };
    if (!intact) result.modified = true;
    if (!(field.ownerDocument.defaultView ?? window).isSecureContext) result.insecure = true;
    return result;
  } catch {
    // Chrome reports a throwing injected function as a null result with no
    // error, so make failures explicit.
    return { filled: 0, reason: "error" };
  }
}
