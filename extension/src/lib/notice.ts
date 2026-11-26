// A one-shot, secret-free message from the background context to the popup.
//
// A context-menu or shortcut fill has no UI of its own. The toolbar badge
// is the first signal, but the button is hidden in the extensions menu
// unless the user pinned it, so the reason is also left here for the popup
// to show the next time it opens. storage.session is memory-only and is
// cleared when the browser exits. Only fixed, localized text is stored.

const KEY = "notice.v1";
const MAX_AGE_MS = 60_000;

type Notice = { message: string; at: number };

export async function setNotice(message: string): Promise<void> {
  try {
    await chrome.storage.session.set({ [KEY]: { message, at: Date.now() } satisfies Notice });
  } catch {
    // storage.session is unavailable; the badge still carries the signal.
  }
}

export async function clearNotice(): Promise<void> {
  try {
    await chrome.storage.session.remove(KEY);
  } catch {
    // Nothing to clear.
  }
}

/** Returns the pending notice, if it is recent, and removes it. */
export async function takeNotice(): Promise<string | null> {
  try {
    const notice = (await chrome.storage.session.get(KEY))[KEY] as Partial<Notice> | undefined;
    if (!notice) return null;
    await chrome.storage.session.remove(KEY);
    if (typeof notice.message !== "string" || typeof notice.at !== "number") return null;
    return Date.now() - notice.at <= MAX_AGE_MS ? notice.message : null;
  } catch {
    return null;
  }
}
