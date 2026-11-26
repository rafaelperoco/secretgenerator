import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { REPO_ROOT } from "../../scripts/common.mjs";
import { importBuilt } from "./helpers.mjs";

// Importing the module in Node, where there is no `chrome` global, also
// shows that it touches no extension API at load time.
const { DEFAULTS, ENCODINGS, KINDS, LIMITS, TABS, bindingOptions, sanitize } =
  await importBuilt("lib/settings.js");

describe("sanitize", () => {
  test("returns the defaults for input that is not a settings object", () => {
    for (const garbage of [undefined, null, 0, 42, "", "settings", true, [], [1, 2], () => {}]) {
      assert.deepEqual(sanitize(garbage), DEFAULTS, String(garbage));
    }
  });

  test("returns the defaults for sections and fields of the wrong type", () => {
    const garbage = {
      tab: 7,
      password: "hunter2",
      passphrase: [],
      secret: null,
      apiKey: 12,
      pin: { digits: {}, acknowledgeLowEntropy: "yes" },
    };
    assert.deepEqual(sanitize(garbage), DEFAULTS);
    assert.deepEqual(
      sanitize({
        password: { length: [], charsetId: 5, exclude: 9, requiredClasses: "lower", allowWeak: 1 },
        passphrase: { words: null, separator: {}, capitalize: "true", digitSuffix: 0 },
        secret: { bytes: true, encoding: 3, prefix: [] },
        apiKey: { prefix: null, separator: 1, length: "long" },
      }),
      DEFAULTS,
    );
  });

  test("never hands out the DEFAULTS objects themselves", () => {
    const first = sanitize(undefined);
    first.password.requiredClasses.push("symbol");
    first.password.length = 1;
    assert.deepEqual(sanitize(undefined), DEFAULTS);
    assert.deepEqual(DEFAULTS.password.requiredClasses, ["lower", "upper", "digit"]);
  });

  // Form controls and older stored data deliver numbers as strings.
  test("coerces numeric strings", () => {
    const s = sanitize({
      password: { length: "32" },
      passphrase: { words: " 5 " },
      secret: { bytes: "64" },
      apiKey: { length: "40" },
      pin: { digits: "8" },
    });
    assert.equal(s.password.length, 32);
    assert.equal(s.passphrase.words, 5);
    assert.equal(s.secret.bytes, 64);
    assert.equal(s.apiKey.length, 40);
    assert.equal(s.pin.digits, 8);
  });

  test("truncates fractions and falls back on values that are not numbers", () => {
    assert.equal(sanitize({ password: { length: 12.9 } }).password.length, 12);
    assert.equal(sanitize({ password: { length: "12.9" } }).password.length, 12);
    for (const bad of [
      "",
      "   ",
      "abc",
      "12px",
      NaN,
      Infinity,
      -Infinity,
      "Infinity",
      null,
      true,
    ]) {
      assert.equal(
        sanitize({ password: { length: bad } }).password.length,
        DEFAULTS.password.length,
        String(bad),
      );
    }
  });

  test("clamps every number to LIMITS", () => {
    const fields = [
      ["password", "length", LIMITS.passwordLength],
      ["passphrase", "words", LIMITS.passphraseWords],
      ["secret", "bytes", LIMITS.secretBytes],
      ["apiKey", "length", LIMITS.apiKeyLength],
      ["pin", "digits", LIMITS.pinDigits],
    ];
    for (const [section, field, limit] of fields) {
      const at = (value) => sanitize({ [section]: { [field]: value } })[section][field];
      assert.equal(at(limit.min - 1), limit.min, `${section}.${field} below`);
      assert.equal(at(-1e9), limit.min, `${section}.${field} far below`);
      assert.equal(at(limit.max + 1), limit.max, `${section}.${field} above`);
      assert.equal(at("999999999"), limit.max, `${section}.${field} far above`);
      assert.equal(at(limit.min), limit.min);
      assert.equal(at(limit.max), limit.max);
    }
  });

  test("rejects a tab, encoding or charset id it cannot accept", () => {
    assert.equal(sanitize({ tab: "history" }).tab, DEFAULTS.tab);
    for (const tab of TABS) assert.equal(sanitize({ tab }).tab, tab);

    assert.equal(sanitize({ secret: { encoding: "rot13" } }).secret.encoding, "base64url");
    assert.equal(sanitize({ secret: { encoding: "HEX" } }).secret.encoding, "base64url");
    for (const encoding of ENCODINGS) {
      assert.equal(sanitize({ secret: { encoding } }).secret.encoding, encoding);
    }

    // Charset ids come from the core at run time, so only their shape can
    // be checked here; the core refuses a well-formed id it does not know.
    for (const bad of ["", "Alphanum-v1", "alphanum v1", "<script>", "a_b", "../etc"]) {
      assert.equal(
        sanitize({ password: { charsetId: bad } }).password.charsetId,
        DEFAULTS.password.charsetId,
        bad,
      );
    }
    assert.equal(sanitize({ password: { charsetId: "hex-v1" } }).password.charsetId, "hex-v1");
  });

  test("keeps only known character classes, once each, in a fixed order", () => {
    const classes = (requiredClasses) =>
      sanitize({ password: { requiredClasses } }).password.requiredClasses;
    assert.deepEqual(classes(["symbol", "space", "lower", "lower", 7, null]), ["lower", "symbol"]);
    assert.deepEqual(classes(["LOWER", "Digit"]), []);
    assert.deepEqual(classes([]), []);
    assert.deepEqual(classes("lower,upper"), DEFAULTS.password.requiredClasses);
  });

  test("accepts booleans only as booleans", () => {
    const on = sanitize({
      password: { allowWeak: true },
      passphrase: { capitalize: true, digitSuffix: true },
      pin: { acknowledgeLowEntropy: true },
    });
    assert.equal(on.password.allowWeak, true);
    assert.equal(on.passphrase.capitalize, true);
    assert.equal(on.passphrase.digitSuffix, true);
    assert.equal(on.pin.acknowledgeLowEntropy, true);
    // The acknowledgement gate must not open on a truthy leftover.
    for (const truthy of ["true", 1, "on", {}, []]) {
      assert.equal(
        sanitize({ pin: { acknowledgeLowEntropy: truthy } }).pin.acknowledgeLowEntropy,
        false,
      );
      assert.equal(sanitize({ password: { allowWeak: truthy } }).password.allowWeak, false);
    }
  });

  test("limits the length of free text", () => {
    const long = "x".repeat(500);
    const s = sanitize({
      password: { exclude: long },
      passphrase: { separator: long },
      secret: { prefix: long },
      apiKey: { prefix: long, separator: long },
    });
    assert.equal(s.password.exclude.length, 128);
    assert.equal(s.passphrase.separator.length, 8);
    assert.equal(s.secret.prefix.length, 64);
    assert.equal(s.apiKey.prefix.length, 32);
    assert.equal(s.apiKey.separator.length, 4);
    // An empty string is kept as it is, not replaced by the default: the
    // core applies its own default for it, which the popup shows as the
    // placeholder of the empty field.
    assert.equal(sanitize({ passphrase: { separator: "" } }).passphrase.separator, "");
  });

  test("is idempotent and drops unknown fields", () => {
    const once = sanitize({
      tab: "pin",
      password: { length: "300", requiredClasses: ["digit", "x"], extra: 1 },
      history: ["never stored"],
    });
    assert.deepEqual(sanitize(once), once);
    assert.equal("history" in once, false);
    assert.equal("extra" in once.password, false);
    assert.deepEqual(Object.keys(once).sort(), Object.keys(DEFAULTS).sort());
  });
});

describe("bindingOptions", () => {
  // The Go bindings read each option with a typed accessor, and syscall/js
  // panics when the JavaScript value has another type. The accessors are
  // the contract, so it is read from the Go source.
  const go = readFileSync(path.join(REPO_ROOT, "web", "wasm", "main.go"), "utf8");
  const JS_TYPE = { Int: "number", String: "string", Bool: "boolean", Float: "number" };

  function goOptions(kind) {
    const wrapper = new RegExp(`"${kind}":\\s*js\\.FuncOf\\((\\w+)\\)`).exec(go)?.[1];
    assert.ok(wrapper, `main.go registers no "${kind}" binding`);
    const body = new RegExp(`func ${wrapper}\\([^]*?\\n}\\n`).exec(go)?.[0];
    assert.ok(body, `main.go has no func ${wrapper}`);
    const options = {};
    for (const [, accessor, key] of body.matchAll(
      /\bopt(Int|String|Bool|Float)\(\s*\w+\s*,\s*"(\w+)"/g,
    )) {
      options[key] = JS_TYPE[accessor];
    }
    assert.ok(Object.keys(options).length > 0, `found no options in func ${wrapper}`);
    return options;
  }

  const hostile = sanitize({
    password: { length: "24", charsetId: 5, exclude: null, requiredClasses: "x", allowWeak: "no" },
    passphrase: { words: "6", separator: 1, capitalize: 1, digitSuffix: "true" },
    secret: { bytes: "48", encoding: null, prefix: 7 },
    apiKey: { prefix: {}, separator: [], length: "20" },
    pin: { digits: "8", acknowledgeLowEntropy: "yes" },
  });

  for (const [label, settings] of [
    ["defaults", sanitize(undefined)],
    ["coerced input", hostile],
  ]) {
    test(`passes only primitives of the type each Go accessor reads (${label})`, () => {
      for (const kind of KINDS) {
        const expected = goOptions(kind);
        const options = bindingOptions(kind, settings);
        assert.ok(Object.keys(options).length > 0, kind);
        for (const [key, value] of Object.entries(options)) {
          assert.ok(key in expected, `${kind}.${key} is not an option the Go binding reads`);
          assert.equal(typeof value, expected[key], `${kind}.${key}`);
          if (typeof value === "number") assert.ok(Number.isInteger(value), `${kind}.${key}`);
        }
      }
    });
  }

  test("maps each kind to the expected option names and types", () => {
    const types = (kind) =>
      Object.fromEntries(
        Object.entries(bindingOptions(kind, hostile)).map(([key, value]) => [key, typeof value]),
      );
    assert.deepEqual(types("password"), {
      length: "number",
      charsetId: "string",
      exclude: "string",
      requiredClasses: "string",
      allowWeak: "boolean",
    });
    assert.deepEqual(types("passphrase"), {
      words: "number",
      separator: "string",
      capitalize: "boolean",
      digitSuffix: "boolean",
    });
    assert.deepEqual(types("secret"), { bytes: "number", encoding: "string", prefix: "string" });
    assert.deepEqual(types("apiKey"), { prefix: "string", separator: "string", length: "number" });
    assert.deepEqual(types("pin"), { digits: "number", acknowledgeLowEntropy: "boolean" });
  });

  test("joins the required classes into the comma-separated form the core parses", () => {
    const settings = sanitize({ password: { requiredClasses: ["digit", "lower"] } });
    assert.equal(bindingOptions("password", settings).requiredClasses, "lower,digit");
    const none = sanitize({ password: { requiredClasses: [] } });
    assert.equal(bindingOptions("password", none).requiredClasses, "");
  });

  test("returns a copy, not the settings section itself", () => {
    const settings = sanitize(undefined);
    bindingOptions("pin", settings).acknowledgeLowEntropy = true;
    assert.equal(settings.pin.acknowledgeLowEntropy, false);
  });
});
