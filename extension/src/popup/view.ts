// Everything the popup shows about a value: the generator result area, the
// Check tab's result and the status line. The generated value is written
// to #output with textContent and read back from there, so the DOM is the
// only place that holds it between a generation and a Copy or Fill.
import type { Estimate, Generated } from "../lib/generate.js";
import { languageTag, t } from "../lib/i18n.js";
import type { Kind } from "../lib/settings.js";
import type { CrackTimeEstimate } from "../lib/wasm.js";
import { byId } from "./dom.js";

// The headline crack time is for the strongest attacker the core models.
const STRONGEST_PROFILE = "nation-state-v1";

const STATUS_OK_MS = 4000;
// Failure texts are two or three lines long and need more reading time.
const STATUS_BAD_MS = 8000;

// One decimal in the language of the text around it ("119,1" in pt-BR). No
// digit grouping, so the text still parses as a number.
function formatBits(bits: number): string {
  try {
    return new Intl.NumberFormat(languageTag(), {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
      useGrouping: false,
    }).format(bits);
  } catch {
    return bits.toFixed(1);
  }
}

function lengthText(count: number): string {
  return count === 1 ? t("popupLengthOne") : t("popupLengthMany", String(count));
}

const CLASS_LABELS: Partial<Record<string, () => string>> = {
  lower: () => t("popupClassLower"),
  upper: () => t("popupClassUpper"),
  digit: () => t("popupClassDigit"),
  symbol: () => t("popupClassSymbol"),
};

function renderCrackTimes(
  times: CrackTimeEstimate[],
  headline: HTMLElement,
  list: HTMLElement,
): void {
  // The core orders profiles from the weakest attacker to the strongest,
  // so the last one is the right fallback if the id is ever renamed.
  const strongest = times.find((e) => e.profile_id === STRONGEST_PROFILE) ?? times.at(-1);
  headline.textContent = strongest?.human_readable ?? "";
  list.replaceChildren(
    ...times.flatMap((e) => {
      const profile = document.createElement("dt");
      profile.textContent = e.description;
      const time = document.createElement("dd");
      time.textContent = e.human_readable;
      return [profile, time];
    }),
  );
}

function setMessage(el: HTMLElement, message: string): void {
  el.textContent = message;
  el.hidden = message === "";
}

/** The value on display, or "" when there is none. */
export function outputValue(): string {
  return byId("output").textContent ?? "";
}

// Empties the result area. Called before anything else is shown, so a
// failed or skipped generation can never leave an old value behind for
// Copy or Fill.
function clearResult(): void {
  byId("output").textContent = "";
  byId("meta").hidden = true;
  byId("warnings").replaceChildren();
  byId("warnings").hidden = true;
  setMessage(byId("error"), "");
  setMessage(byId("hint"), "");
}

export function showValue(kind: Kind, result: Generated): void {
  clearResult();
  const output = byId("output");
  output.textContent = result.value;
  // The stylesheet wraps a passphrase differently from a random string.
  output.dataset.kind = kind;
  byId("entropy-bits").textContent = t("popupEntropy", formatBits(result.entropyBits));
  // Counted here because the core's `length` means words for a passphrase
  // and excludes the prefix of an API key.
  byId("length").textContent = lengthText(Array.from(result.value).length);
  renderCrackTimes(result.crackTimes, byId("crack-time"), byId("crack-list"));
  byId("crack-details").hidden = result.crackTimes.length === 0;
  byId("meta").hidden = false;

  const warnings = byId("warnings");
  warnings.replaceChildren(
    ...result.warnings.map((warning) => {
      const item = document.createElement("li");
      item.textContent = warning;
      return item;
    }),
  );
  warnings.hidden = result.warnings.length === 0;
}

/** Shows a generator error in place of the value. */
export function showError(message: string): void {
  clearResult();
  setMessage(byId("error"), message);
}

/** Shows a neutral explanation in place of the value. */
export function showHint(message: string): void {
  clearResult();
  setMessage(byId("hint"), message);
}

/** Check tab: the estimate, an error, or (both null) the empty-input hint. */
export function showCheck(estimate: Estimate | null, error: string | null = null): void {
  byId("check-hint").hidden = estimate !== null || error !== null;
  byId("check-details").hidden = estimate === null;
  setMessage(byId("check-error"), error ?? "");
  if (estimate === null) return;

  byId("check-bits").textContent = t("popupEntropy", formatBits(estimate.entropyBits));
  byId("check-length").textContent = lengthText(estimate.length);
  const classes = estimate.classes
    .split(",")
    .filter((name) => name !== "")
    .map((name) => CLASS_LABELS[name]?.() ?? name);
  byId("check-classes").textContent = t("popupCheckClasses", classes.join(", "));
  renderCrackTimes(estimate.crackTimes, byId("check-crack-time"), byId("check-crack-list"));
}

let statusTimer: number | undefined;

export function clearStatus(): void {
  window.clearTimeout(statusTimer);
  const status = byId("status");
  status.replaceChildren();
  delete status.dataset.state;
}

/**
 * Shows a short result in the live region and removes it after a few
 * seconds. `warning` is appended in the warning colour.
 */
export function setStatus(message: string, ok: boolean, warning?: string): void {
  clearStatus();
  const status = byId("status");
  status.dataset.state = ok ? "ok" : "bad";
  status.append(message);
  if (warning) {
    const extra = document.createElement("span");
    extra.className = "status-warning";
    extra.textContent = warning;
    status.append(" ", extra);
  }
  statusTimer = window.setTimeout(clearStatus, ok ? STATUS_OK_MS : STATUS_BAD_MS);
}
