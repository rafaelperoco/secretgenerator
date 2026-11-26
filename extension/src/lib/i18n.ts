// Thin wrapper over chrome.i18n. Strings live in static/_locales.

/** Localized message, or the key itself when it is missing (visible in tests). */
export function t(key: string, ...substitutions: string[]): string {
  return chrome.i18n.getMessage(key, substitutions) || key;
}

/**
 * BCP 47 tag of the locale the messages come from. That is not always the
 * browser's UI language: for a language without a _locales folder the
 * browser falls back to default_locale and the text is English.
 */
export function languageTag(): string {
  return chrome.i18n.getMessage("languageTag") || "en";
}

/**
 * Fills in static markup. Supported attributes:
 *   data-i18n="key"              -> textContent
 *   data-i18n-title="key"        -> title
 *   data-i18n-aria-label="key"   -> aria-label
 *   data-i18n-placeholder="key"  -> placeholder
 * textContent only: messages are never parsed as HTML.
 */
export function localize(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n ?? "");
  }
  const attrs = [
    ["i18nTitle", "title"],
    ["i18nAriaLabel", "aria-label"],
    ["i18nPlaceholder", "placeholder"],
  ] as const;
  for (const [data, attr] of attrs) {
    const selector = `[data-${data.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}]`;
    for (const el of root.querySelectorAll<HTMLElement>(selector)) {
      el.setAttribute(attr, t(el.dataset[data] ?? ""));
    }
  }
  // Screen readers pick the voice from this, so it names the language of
  // the text and not the language of the browser.
  if (root === document) document.documentElement.lang = languageTag();
}
