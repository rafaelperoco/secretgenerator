// Injected into the page with chrome.scripting.executeScript. It must be
// self-contained: executeScript serializes the function source, so it can
// not reference anything outside its own body.

export type FillResult = { filled: number; reason?: string };

export function fillFocusedField(value: string): FillResult {
  if (!document.hasFocus()) return { filled: 0, reason: "no-focus" };

  let el: Element | null = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) {
    el = el.shadowRoot.activeElement;
  }

  const textTypes = ["password", "text", "search", "tel", "url", "email", ""];
  const isFillable = (e: Element | null): e is HTMLInputElement | HTMLTextAreaElement =>
    (e instanceof HTMLInputElement && textTypes.includes(e.type)) ||
    e instanceof HTMLTextAreaElement;

  if (!isFillable(el)) return { filled: 0, reason: "not-editable" };
  if (el.disabled || el.readOnly) return { filled: 0, reason: "read-only" };

  // Use the native setter so frameworks that track the value property
  // (React, Vue) see the change, then fire the events they listen to.
  const setValue = (target: HTMLInputElement | HTMLTextAreaElement) => {
    const proto = Object.getPrototypeOf(target) as object;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(target, value);
    else target.value = value;
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
  };

  setValue(el);
  let filled = 1;

  // Sign-up forms usually ask for the new password twice. Fill the next
  // empty, editable password field in the same form as the confirmation.
  if (el instanceof HTMLInputElement && el.type === "password") {
    const scope: ParentNode = el.form ?? el.getRootNode() as ParentNode;
    const fields = Array.from(scope.querySelectorAll<HTMLInputElement>('input[type="password"]'));
    const confirm = fields
      .slice(fields.indexOf(el) + 1)
      .find((f) => !f.value && !f.disabled && !f.readOnly && f.getClientRects().length > 0);
    if (confirm) {
      setValue(confirm);
      filled++;
    }
  }
  return { filled };
}
