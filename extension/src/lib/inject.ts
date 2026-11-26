// Runs fillFocusedField in a tab and normalizes every way it can fail into
// a FillOutcome. Requires the activeTab grant, which the browser gives for
// a context-menu click, a commands shortcut, or opening the action popup.
import { type FillMode, type FillReason, type FillResult, fillFocusedField } from "./fill.js";
import { t } from "./i18n.js";

/**
 * "blocked": the browser refused the injection. That happens on browser
 * pages, extension stores and the PDF viewer, and when a context-menu click
 * landed in a frame from another origin (activeTab covers the top-level
 * page and same-origin frames only).
 */
export type FillOutcome = Omit<FillResult, "reason"> & { reason?: FillReason | "blocked" };

/**
 * @param frameId Frame to inject into. Pass the clicked frame for a context
 *   menu; omit for the popup and the shortcut, where the function starts at
 *   the top frame and follows focus into same-origin frames itself.
 */
export async function fillInTab(
  tabId: number,
  value: string,
  mode: FillMode,
  frameId?: number,
): Promise<FillOutcome> {
  let results: chrome.scripting.InjectionResult<FillResult>[];
  try {
    results = await chrome.scripting.executeScript({
      target: frameId === undefined ? { tabId } : { tabId, frameIds: [frameId] },
      func: fillFocusedField,
      args: [value, mode],
      // Without this the call waits for document_idle on a loading page.
      injectImmediately: true,
    });
  } catch {
    return { filled: 0, reason: "blocked" };
  }
  // Chrome reports a throwing or non-serializable function as a null result.
  const result = results?.[0]?.result;
  if (!result || typeof result.filled !== "number") return { filled: 0, reason: "error" };
  return result;
}

/** True when at least one field was written. */
export function succeeded(outcome: FillOutcome): boolean {
  return outcome.filled > 0;
}

/** A one-line, localized description of a fill outcome. Never includes the value. */
export function outcomeMessage(outcome: FillOutcome): string {
  if (outcome.filled > 0) {
    if (outcome.modified) return t("fillModified");
    return outcome.filled > 1 ? t("fillOkConfirm") : t("fillOk");
  }
  switch (outcome.reason) {
    case "too-long":
      return t("fillTooLong", String(outcome.maxLength ?? ""));
    case "cross-origin-frame":
      return t("fillCrossOrigin");
    case "blocked":
      return t("fillBlocked");
    case "not-password":
      return t("fillNotPassword");
    case "read-only":
      return t("fillReadOnly");
    case "hidden":
      return t("fillHidden");
    case "no-field":
      return t("fillNoField");
    default:
      return t("fillError");
  }
}
