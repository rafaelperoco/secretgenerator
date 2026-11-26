// Popup entry point. Connects the tab strip, the option controls and the
// Regenerate / Copy / Fill buttons to the shared generator modules.
//
// A generated value exists only in #output (see view.ts) and the password
// typed on the Check tab only in its input. Neither is written to storage,
// the URL or the title, and nothing here logs.
import { estimate, generate } from "../lib/generate.js";
import { localize, t } from "../lib/i18n.js";
import { fillInTab, outcomeMessage, succeeded } from "../lib/inject.js";
import { takeNotice } from "../lib/notice.js";
import {
  KINDS,
  type Settings,
  type Tab,
  loadSettings,
  sanitize,
  saveSettings,
} from "../lib/settings.js";
import { charsetIds } from "../lib/wasm.js";
import { byId } from "./dom.js";
import { type OptionsForm, createOptionsForm } from "./form.js";
import { focusTab, initTabs, showTab } from "./tabs.js";
import {
  clearStatus,
  outputValue,
  setStatus,
  showCheck,
  showError,
  showHint,
  showValue,
} from "./view.js";

// Must match the command name in the manifest.
const FILL_COMMAND = "fill-password";
const TYPING_DEBOUNCE_MS = 150;

let settings: Settings = sanitize(null);
let form: OptionsForm;
/** Tab that Fill targets, or null when the page cannot be filled. */
let fillTabId: number | null = null;

type Debounced = { schedule(): void; cancel(): void; readonly pending: boolean };

function debounce(run: () => void, ms: number): Debounced {
  let timer: number | undefined;
  return {
    schedule() {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = undefined;
        run();
      }, ms);
    },
    cancel() {
      window.clearTimeout(timer);
      timer = undefined;
    },
    get pending() {
      return timer !== undefined;
    },
  };
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// The core refuses to make a PIN until its low entropy is acknowledged.
// That is a deliberate gate, not a failure, so the popup does not call the
// core at all and explains the checkbox instead of showing an error.
const pinGated = (): boolean => settings.tab === "pin" && !settings.pin.acknowledgeLowEntropy;

function updateActions(): void {
  const hasValue = outputValue() !== "";
  byId<HTMLButtonElement>("btn-generate").disabled = pinGated();
  const copy = byId<HTMLButtonElement>("btn-copy");
  copy.disabled = !hasValue;
  copy.title = hasValue ? "" : t("popupNoValue");
  const fill = byId<HTMLButtonElement>("btn-fill");
  fill.disabled = !hasValue || fillTabId === null;
  fill.title = fillTabId === null ? t("popupFillUnavailable") : hasValue ? "" : t("popupNoValue");
}

let generation = 0;

/** Generates a value for the current tab and shows it, or why there is none. */
async function regenerate(): Promise<void> {
  const tab = settings.tab;
  if (tab === "entropy") return;
  // The newest call wins. The first one also loads the WASM core and must
  // not overwrite the result of a later, faster call.
  const run = ++generation;
  if (pinGated()) {
    showHint(t("popupPinHint"));
  } else {
    try {
      const result = await generate(tab, settings);
      if (run !== generation) return;
      showValue(tab, result);
    } catch (error) {
      if (run !== generation) return;
      showError(errorText(error));
    }
  }
  updateActions();
}

let checkRun = 0;

/** Estimates the password typed on the Check tab. It is read, never kept. */
async function runCheck(): Promise<void> {
  const password = byId<HTMLInputElement>("check-input").value;
  const run = ++checkRun;
  if (password === "") {
    showCheck(null);
    return;
  }
  try {
    const result = await estimate(password);
    if (run === checkRun) showCheck(result);
  } catch (error) {
    if (run === checkRun) showCheck(null, errorText(error));
  }
}

const refresh = (): Promise<void> => (settings.tab === "entropy" ? runCheck() : regenerate());

/** Saves the settings and regenerates for them. */
function apply(): void {
  typing.cancel();
  clearStatus();
  saveSettings(settings).catch(() => setStatus(t("popupSaveFailed"), false));
  void refresh();
}

const typing = debounce(apply, TYPING_DEBOUNCE_MS);
const checking = debounce(() => void runCheck(), TYPING_DEBOUNCE_MS);

// Text and number fields are edited by typing. Their commit on blur is
// debounced like a keystroke, never applied at once: a blur usually means
// the mouse button just went down on something else, and a regeneration at
// that moment can change the height of the value box and move that
// something away before the button comes up, which loses the click.
const isTyped = (target: EventTarget | null): boolean =>
  target instanceof HTMLInputElement && (target.type === "text" || target.type === "number");

// One handler for every option control. `input` fires on each keystroke
// and slider step and is debounced. `change` fires when an edit is
// committed; for a checkbox, a select or the slider that applies at once.
// An event that leaves the settings as they were, such as a blur without
// an edit, must not replace the value the user is looking at.
function onOption(event: Event, committed: boolean): void {
  const next = form.read(settings, event.target);
  const changed = JSON.stringify(next) !== JSON.stringify(settings);
  settings = next;
  form.write(settings, committed ? null : event.target);
  if (committed && !isTyped(event.target)) {
    if (changed || typing.pending) apply();
  } else if (changed) {
    // Saved at once as well, not only by the debounced apply(): the popup
    // can close inside the pause (Escape right after the last digit), and
    // a write that starts while it closes does not get through. A failure
    // is reported by the save in apply().
    saveSettings(settings).catch(() => {});
    typing.schedule();
  }
}

function showCurrentTab(): void {
  const generator = settings.tab !== "entropy";
  showTab(settings.tab);
  byId("result").hidden = !generator;
  byId("facts").hidden = !generator;
}

function selectTab(tab: Tab): void {
  if (tab === settings.tab) return;
  settings = { ...settings, tab };
  showCurrentTab();
  apply();
}

async function copyValue(): Promise<void> {
  const value = outputValue();
  if (value === "") return;
  try {
    // Called straight from the click: that is the user gesture the
    // clipboard asks for, so no clipboardWrite permission is needed.
    await navigator.clipboard.writeText(value);
    setStatus(t("popupCopied"), true);
  } catch {
    setStatus(t("popupCopyFailed"), false);
  }
}

let filling = false;

async function fillValue(): Promise<void> {
  const value = outputValue();
  if (value === "" || fillTabId === null || filling) return;
  filling = true;
  try {
    const outcome = await fillInTab(fillTabId, value, "popup");
    setStatus(
      outcomeMessage(outcome),
      succeeded(outcome),
      outcome.insecure ? t("popupFillInsecure") : undefined,
    );
  } finally {
    filling = false;
  }
}

function toggleCheckVisibility(): void {
  const input = byId<HTMLInputElement>("check-input");
  const reveal = input.type === "password";
  input.type = reveal ? "text" : "password";
  byId("check-toggle").textContent = reveal ? t("popupCheckHide") : t("popupCheckShow");
}

/** The tab Fill should write to, or null when filling is not possible. */
async function findFillTab(): Promise<number | null> {
  // Tests open popup.html in a tab of its own and name the page to fill.
  const override = new URLSearchParams(location.search).get("tabId");
  if (override !== null) return /^\d+$/.test(override) ? Number(override) : null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    // Without the "tabs" permission a tab has a url only where activeTab
    // applies, so no url means a page the browser keeps extensions out of
    // (browser pages, the stores). The popup's own page is one of those too.
    if (tab?.id === undefined || !tab.url) return null;
    return tab.url.startsWith(chrome.runtime.getURL("")) ? null : tab.id;
  } catch {
    return null;
  }
}

/** The fill shortcut, "" when unassigned, null when there is no commands API. */
async function fillShortcut(): Promise<string | null> {
  // chrome.commands is missing on mobile browsers.
  if (!chrome.commands?.getAll) return null;
  try {
    const commands = await chrome.commands.getAll();
    return commands.find((command) => command.name === FILL_COMMAND)?.shortcut ?? "";
  } catch {
    return "";
  }
}

function showShortcut(shortcut: string | null): void {
  if (shortcut === null) {
    byId("shortcut-line").hidden = true;
    return;
  }
  const key = byId("shortcut");
  key.textContent = shortcut === "" ? t("popupShortcutUnset") : shortcut;
  key.classList.toggle("key", shortcut !== "");
  if (shortcut !== "") return;
  // A suggested key that collides with a browser shortcut is left
  // unassigned without any message, so say where to set one.
  const firefox = chrome.runtime.getURL("").startsWith("moz-extension://");
  const hint = byId("shortcut-hint");
  hint.textContent = firefox ? t("popupShortcutHintFirefox") : t("popupShortcutHintChrome");
  hint.hidden = false;
}

function listen(): void {
  initTabs(selectTab);
  for (const kind of KINDS) {
    const panel = byId(`panel-${kind}`);
    panel.addEventListener("input", (event) => onOption(event, false));
    panel.addEventListener("change", (event) => onOption(event, true));
  }
  byId("btn-generate").addEventListener("click", () => {
    // An edit still waiting for its debounce has to be saved as well.
    if (typing.pending) {
      apply();
      return;
    }
    clearStatus();
    void regenerate();
  });
  byId("btn-copy").addEventListener("click", () => void copyValue());
  byId("btn-fill").addEventListener("click", () => void fillValue());
  byId("check-input").addEventListener("input", checking.schedule);
  byId("check-toggle").addEventListener("click", toggleCheckVisibility);
}

async function init(): Promise<void> {
  try {
    localize();
    byId("version").textContent = chrome.runtime.getManifest().version;

    const [stored, charsets, notice, target, shortcut] = await Promise.all([
      loadSettings().catch(() => sanitize(null)),
      // If the core cannot load, the first generation fails the same way
      // and shows the reason; the list is simply empty until then.
      charsetIds().catch((): string[] => []),
      takeNotice(),
      findFillTab(),
      fillShortcut(),
    ]);
    settings = stored;
    fillTabId = target;
    form = createOptionsForm(charsets);
    form.write(settings);

    if (notice) {
      byId("notice").textContent = notice;
      byId("notice").hidden = false;
    }
    if (fillTabId === null) {
      byId("fill-hint").textContent = t("popupFillUnavailable");
      byId("fill-hint").hidden = false;
    }
    showShortcut(shortcut);
    showCurrentTab();
    listen();
    await refresh();

    // Until now only the first tab was in the Tab order. If focus already
    // went there and a different tab was restored, move it along so focus
    // and selection agree. Otherwise nothing is focused on open.
    if (document.activeElement?.getAttribute("role") === "tab") focusTab(settings.tab);
  } finally {
    // Tests wait for this, so it is set even when start-up failed.
    document.body.dataset.ready = "true";
  }
}

void init();
