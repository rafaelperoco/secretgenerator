// Background entry point: a service worker in Chrome and Edge, an event
// page (background module) in Firefox. Both are stopped when idle and
// started again for the next event, so this file keeps no state and only
// registers listeners, synchronously at the top level. A listener added
// after an await would miss the event that woke the context.
import { runFill } from "./lib/fill-flow.js";
import { t } from "./lib/i18n.js";

const MENU_ID = "fill-password";
const COMMAND = "fill-password";

type MenuContexts = NonNullable<chrome.contextMenus.CreateProperties["contexts"]>;
// @types/chrome describes Chrome, which has no "password" context.
type MenuContext = MenuContexts[number] | "password";

// Firefox has a separate "password" context. Its documentation says that
// "editable" leaves password fields out while its source suggests otherwise,
// so both are listed there. Chrome's "editable" covers password fields, and
// Chrome throws synchronously on the value it does not know.
function menuContexts(): MenuContexts {
  const firefox = chrome.runtime.getURL("").startsWith("moz-extension://");
  const contexts: [MenuContext, ...MenuContext[]] = firefox
    ? ["editable", "password"]
    : ["editable"];
  return contexts as MenuContexts;
}

// Menu items persist across restarts of the background context. They are
// created on install, update and browser start only: at the top level every
// wake would fail with a duplicate id. create() returns no promise; errors
// arrive through the callback as runtime.lastError, which has to be read or
// the browser reports it as unchecked.
//
// There is exactly one item on purpose: browsers move two or more items of
// one extension into a submenu.
function createMenu(): void {
  chrome.contextMenus?.removeAll(() => {
    void chrome.runtime.lastError;
    chrome.contextMenus.create(
      {
        id: MENU_ID,
        title: t("menuFillPassword"),
        contexts: menuContexts(),
        // Keeps the item off browser, extension and devtools pages, where
        // the injection would be refused anyway.
        documentUrlPatterns: ["http://*/*", "https://*/*", "file:///*"],
      },
      () => void chrome.runtime.lastError,
    );
  });
}

async function fillFromShortcut(tab: chrome.tabs.Tab | undefined): Promise<void> {
  let tabId = tab?.id;
  if (tabId === undefined) {
    try {
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      tabId = active?.id;
    } catch {
      // No tab to act on.
    }
  }
  if (tabId === undefined) return;
  // No frame id: the injected function starts at the top frame and follows
  // focus into same-origin frames itself.
  await runFill(tabId, "command");
}

chrome.runtime.onInstalled.addListener(createMenu);
chrome.runtime.onStartup.addListener(createMenu);

// contextMenus and commands are missing in mobile browsers. Unguarded, the
// undefined namespace would throw here and abort the module before the
// remaining listeners are registered.
//
// Both listeners return their promise: Firefox keeps the event page alive
// while a promise returned from a listener is pending.
chrome.contextMenus?.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || tab?.id === undefined) return;
  return runFill(tab.id, "menu", info.frameId ?? 0);
});

chrome.commands?.onCommand.addListener((command, tab) => {
  if (command !== COMMAND) return;
  return fillFromShortcut(tab);
});
