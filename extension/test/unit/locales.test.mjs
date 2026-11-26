import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { describe, test } from "node:test";
import { walkFiles } from "../../scripts/common.mjs";
import { TARGETS, buildManifest } from "../../scripts/manifest.mjs";
import { fromRoot } from "./helpers.mjs";

const LOCALES = ["en", "pt_BR"];
const raw = Object.fromEntries(
  LOCALES.map((locale) => [
    locale,
    readFileSync(fromRoot("static", "_locales", locale, "messages.json"), "utf8"),
  ]),
);
const messages = Object.fromEntries(LOCALES.map((locale) => [locale, JSON.parse(raw[locale])]));

const placeholderNames = (entry) => Object.keys(entry.placeholders ?? {}).sort();
// $NAME$ tokens in a message. Chrome matches them case-insensitively.
const placeholderUses = (entry) =>
  [
    ...new Set([...entry.message.matchAll(/\$([A-Za-z0-9_@]+)\$/g)].map((m) => m[1].toLowerCase())),
  ].sort();

test("the shipped locales are en and pt_BR", () => {
  assert.deepEqual(readdirSync(fromRoot("static", "_locales")).sort(), LOCALES);
});

test("both locales define the same keys", () => {
  assert.deepEqual(Object.keys(messages.pt_BR).sort(), Object.keys(messages.en).sort());
});

for (const locale of LOCALES) {
  describe(`_locales/${locale}`, () => {
    // JSON.parse keeps the last of two equal keys without complaint, and
    // two people add keys to these files. The files keep one key per line
    // at the first indentation level, which is what this counts.
    test("has no key twice", () => {
      const keys = [...raw[locale].matchAll(/^ {2}"([^"]+)":/gm)].map((m) => m[1]);
      assert.ok(keys.length > 0, "expected one key per line, indented by two spaces");
      assert.deepEqual(keys.sort(), Object.keys(messages[locale]).sort());
    });

    // Chrome looks message names up case-insensitively; two names that
    // differ only in case make the extension fail to load.
    test("has valid names that stay unique when case is ignored", () => {
      const keys = Object.keys(messages[locale]);
      for (const key of keys) assert.match(key, /^[A-Za-z0-9_@]+$/);
      assert.equal(new Set(keys.map((key) => key.toLowerCase())).size, keys.length);
    });

    test("gives every message a text and a description", () => {
      for (const [key, entry] of Object.entries(messages[locale])) {
        assert.equal(typeof entry.message, "string", key);
        assert.notEqual(entry.message.trim(), "", key);
        assert.equal(typeof entry.description, "string", `${key}: description`);
        assert.notEqual(entry.description.trim(), "", `${key}: description`);
      }
    });

    test("declares exactly the placeholders each message uses", () => {
      for (const [key, entry] of Object.entries(messages[locale])) {
        assert.deepEqual(placeholderUses(entry), placeholderNames(entry), key);
        for (const placeholder of Object.values(entry.placeholders ?? {})) {
          assert.match(placeholder.content, /^\$[1-9]$/, key);
        }
      }
    });

    // The limit both stores put on the short description.
    test("keeps extDescription within 132 characters", () => {
      const { length } = messages[locale].extDescription.message;
      assert.ok(length <= 132, `${length} characters`);
    });
  });
}

test("placeholders have the same names and positions in both locales", () => {
  for (const [key, entry] of Object.entries(messages.en)) {
    const other = messages.pt_BR[key];
    assert.ok(other, key);
    assert.deepEqual(placeholderNames(other), placeholderNames(entry), key);
    for (const name of placeholderNames(entry)) {
      assert.equal(other.placeholders[name].content, entry.placeholders[name].content, key);
    }
  }
});

describe("every message key that is used exists", () => {
  const known = new Set(Object.keys(messages.en));
  const missing = (keys) => [...new Set(keys)].filter((key) => !known.has(key));

  // t() is the usual way in; lib/i18n.ts also asks chrome.i18n directly.
  test('t("...") and getMessage("...") calls in src/', () => {
    const used = [];
    for (const file of walkFiles(fromRoot("src"))) {
      const source = readFileSync(fromRoot("src", file), "utf8");
      for (const match of source.matchAll(/\b(?:t|getMessage)\(\s*["'`]([A-Za-z0-9_@]+)["'`]/g))
        used.push(match[1]);
    }
    assert.ok(used.length > 0, "found no t() calls; has the helper been renamed?");
    assert.ok(used.includes("languageTag"), "lib/i18n.ts no longer reads languageTag");
    assert.deepEqual(missing(used), []);
  });

  // <html lang> and the number format are taken from this message, so it
  // has to be a tag the browser understands and the one of its own file.
  test("languageTag names the locale of its file", () => {
    assert.equal(messages.en.languageTag.message, "en");
    assert.equal(messages.pt_BR.languageTag.message, "pt-BR");
    for (const locale of LOCALES) {
      const tag = messages[locale].languageTag.message;
      assert.deepEqual(Intl.getCanonicalLocales(tag), [tag], locale);
      assert.equal(tag.replace("-", "_"), locale);
    }
  });

  test("data-i18n attributes in popup.html", () => {
    const html = readFileSync(fromRoot("static", "popup", "popup.html"), "utf8");
    const used = [...html.matchAll(/\sdata-i18n(?:-[a-z-]+)?\s*=\s*["']([^"']*)["']/g)].map(
      (match) => match[1],
    );
    assert.ok(used.length > 0, "found no data-i18n attributes");
    assert.deepEqual(missing(used), []);
  });

  test("__MSG_x__ references in the manifests", () => {
    for (const target of TARGETS) {
      const manifest = JSON.stringify(buildManifest(target, "2.1.0"));
      const used = [...manifest.matchAll(/__MSG_([A-Za-z0-9_@]+)__/g)].map((match) => match[1]);
      assert.ok(used.length >= 4, target);
      assert.deepEqual(missing(used), [], target);
    }
  });
});
