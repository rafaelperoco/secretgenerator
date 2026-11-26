// The "generate a password and fill it" sequence behind the context menu
// item and the keyboard shortcut. Neither has a UI of its own, so every
// outcome is reported on the toolbar badge, and whatever the user has to
// act on is also left as a notice for the popup.
//
// Apart from the key-repeat guard below, nothing is kept between calls.
// Settings are read from storage every time because the background context
// is stopped when idle, and the generated value exists only in local
// variables here until it is handed to the page.
import { clearBadge, showBadge } from "./badge.js";
import { type Generated, generate } from "./generate.js";
import { t } from "./i18n.js";
import { fillInTab, outcomeMessage, succeeded } from "./inject.js";
import { clearNotice, setNotice } from "./notice.js";
import { loadSettings } from "./settings.js";

// A shortcut held a moment too long auto-repeats, and the browser delivers
// every repeat as a new command (measured in Chrome on Linux: 36 commands
// for a key held two seconds). Every one of them would generate and fill
// again, and on a failure every one would clear the notice of the run
// before it and ask for the popup again, so the popup could open without
// its reason. A command that follows the previous command for the same tab
// within this window is therefore dropped. Dropped commands extend the
// window, so a key held for several seconds still fills once. The window
// has to be longer than the initial key-repeat delay, about half a second
// by default on common systems; a repeat that arrives later than the window
// is a second, complete fill, which fill.ts keeps consistent. Forgetting
// this when the background context stops is fine: that takes far longer
// than the window.
const REPEAT_WINDOW_MS = 1000;
let lastCommand = { tabId: -1, at: 0 };

function isKeyRepeat(tabId: number): boolean {
  const now = performance.now();
  const repeat = tabId === lastCommand.tabId && now - lastCommand.at < REPEAT_WINDOW_MS;
  lastCommand = { tabId, at: now };
  return repeat;
}

// Reports a failure on every channel available. The badge comes first, but
// the toolbar button is hidden in the extensions menu unless the user
// pinned it, so the reason is also stored for the popup, which is then
// opened where the browser allows it: there the user can read the reason
// and fall back to Copy.
async function fail(tabId: number, message: string): Promise<void> {
  await showBadge(tabId, false, message);
  // Stored before the popup opens: the popup takes the notice while loading.
  await setNotice(message);
  try {
    // Missing before Chrome 127. Rejects when no browser window has focus,
    // and in Firefox, where the user gesture is gone after the awaits above.
    // The badge and the stored notice remain in both cases.
    if (chrome.action.openPopup) await chrome.action.openPopup();
  } catch {
    // See above.
  }
}

async function attempt(
  tabId: number,
  mode: "menu" | "command",
  frameId: number | undefined,
): Promise<void> {
  // A new attempt replaces whatever feedback the previous one left behind.
  await Promise.all([clearBadge(tabId), clearNotice()]);

  const settings = await loadSettings();
  let generated: Generated;
  try {
    generated = await generate("password", settings);
  } catch (error) {
    // The saved settings can be ones the core refuses, for example a length
    // below the entropy floor. The core's message says which.
    const reason = error instanceof Error ? error.message : String(error);
    await fail(tabId, t("fillGenerateFailed", reason));
    return;
  }

  let outcome = await fillInTab(tabId, generated.value, mode, frameId);
  let message = outcomeMessage(outcome);

  // fill.ts refuses a value longer than the field's maxlength instead of
  // letting the site truncate it. There is nobody to ask on these paths, so
  // retry once at exactly the limit, with the other settings unchanged.
  const limit = outcome.reason === "too-long" ? outcome.maxLength : undefined;
  if (limit !== undefined && Number.isInteger(limit) && limit > 0) {
    try {
      const shorter = await generate("password", {
        ...settings,
        password: { ...settings.password, length: limit },
      });
      outcome = await fillInTab(tabId, shorter.value, mode, frameId);
      // A value the page altered is the more urgent thing to tell the user.
      message =
        succeeded(outcome) && !outcome.modified
          ? t("fillOkShortened", String(limit))
          : outcomeMessage(outcome);
    } catch {
      // The core's entropy floor refuses short passwords (alphanumeric needs
      // 14 or more characters) unless the user allowed weak ones. The
      // original too-long outcome stands; its message names the limit.
    }
  }

  if (!succeeded(outcome)) {
    await fail(tabId, message);
    return;
  }
  await showBadge(tabId, true, message);
  // Filled, but the page changed the value afterwards. That needs the
  // user's attention beyond a badge that disappears.
  if (outcome.modified) await setNotice(message);
}

/**
 * Generates a password with the saved settings and fills it into the tab.
 * Never rejects: listeners return this promise to the browser. A "command"
 * run within a second of the previous one for the same tab does nothing.
 *
 * @param frameId Frame the context menu was opened in. Omit for the
 *   shortcut, where the injected function follows focus from the top frame.
 */
export async function runFill(
  tabId: number,
  mode: "menu" | "command",
  frameId?: number,
): Promise<void> {
  // Checked before anything else so the feedback of the first run stays.
  if (mode === "command" && isKeyRepeat(tabId)) return;
  try {
    await attempt(tabId, mode, frameId);
  } catch {
    // Only reached when storage or an extension API fails unexpectedly.
    try {
      await fail(tabId, t("fillError"));
    } catch {
      // No channel left to report on.
    }
  }
}
