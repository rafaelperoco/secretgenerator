// Transient feedback on the toolbar button for fills that have no UI of
// their own (context menu, keyboard shortcut).
//
// Everything is set per tab, never globally. A global badge lives in the
// browser process, outlives the background context and can get stuck. A
// per-tab badge is dropped by the browser when the tab navigates or closes,
// which also covers a background context that was stopped before the timer
// below could fire.
import { t } from "./i18n.js";

const OK_COLOR = "#15803d";
const FAIL_COLOR = "#b91c1c";
const TEXT_COLOR = "#ffffff";
const VISIBLE_MS = 4000;

// One pending clear per tab, so that a badge shown shortly after another is
// not removed early by the older timer. Losing the map when the background
// context stops is harmless: its timers are lost with it.
const timers = new Map<number, ReturnType<typeof setTimeout>>();

// The tab may be gone by the time a call runs, and the action API then
// rejects. There is nothing left to give feedback on, so that is ignored.
async function quietly(call: () => Promise<void>): Promise<void> {
  try {
    await call();
  } catch {
    // See above.
  }
}

/**
 * Marks the tab's toolbar button with the result of a fill and puts the
 * explanation in its tooltip. Clears itself after a few seconds. The title
 * is shown by the browser, so it must never contain a generated value.
 */
export async function showBadge(tabId: number, ok: boolean, title: string): Promise<void> {
  // Scheduled before the first await: overlapping calls for one tab must
  // leave exactly one timer behind.
  clearTimeout(timers.get(tabId));
  timers.set(
    tabId,
    setTimeout(() => void clearBadge(tabId), VISIBLE_MS),
  );

  const action = chrome.action;
  // Colours first, so the text never shows up in the previous colour.
  await quietly(() => action.setBadgeBackgroundColor({ tabId, color: ok ? OK_COLOR : FAIL_COLOR }));
  // Optional in older browsers, which then pick the text colour themselves.
  if (action.setBadgeTextColor) {
    await quietly(() => action.setBadgeTextColor({ tabId, color: TEXT_COLOR }));
  }
  await quietly(() => action.setBadgeText({ tabId, text: ok ? "OK" : "!" }));
  await quietly(() => action.setTitle({ tabId, title }));
}

/** Removes the tab's badge and restores the default tooltip. */
export async function clearBadge(tabId: number): Promise<void> {
  clearTimeout(timers.get(tabId));
  timers.delete(tabId);
  await quietly(() => chrome.action.setBadgeText({ tabId, text: "" }));
  await quietly(() => chrome.action.setTitle({ tabId, title: t("actionTitle") }));
}
