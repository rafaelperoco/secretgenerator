// User-chosen generator options. Persisted in chrome.storage.local so the
// popup reopens with the last configuration and the context menu / keyboard
// shortcut use the same password settings. Generated values are never
// written to storage.
//
// Everything read from storage or from form controls goes through
// sanitize(): the Go bindings panic on a wrong-typed option (a string where
// a number is expected), so types are coerced and ranges clamped here.

export const KINDS = ["password", "passphrase", "secret", "apiKey", "pin"] as const;
export type Kind = (typeof KINDS)[number];

export const TABS = [...KINDS, "entropy"] as const;
export type Tab = (typeof TABS)[number];

export const CHAR_CLASSES = ["lower", "upper", "digit", "symbol"] as const;
export const ENCODINGS = ["base64url", "base64", "base32", "hex"] as const;

export type Settings = {
  tab: Tab;
  password: {
    length: number;
    charsetId: string;
    exclude: string;
    requiredClasses: string[];
    allowWeak: boolean;
  };
  passphrase: {
    words: number;
    separator: string;
    capitalize: boolean;
    digitSuffix: boolean;
  };
  secret: { bytes: number; encoding: string; prefix: string };
  apiKey: { prefix: string; separator: string; length: number };
  pin: { digits: number; acknowledgeLowEntropy: boolean };
};

// Same as the CLI defaults in docs/SUBCOMMANDS.md, with one deliberate
// difference: passwords require a lowercase letter, an uppercase letter and
// a digit. About 3% of 20-character alphanumeric passwords contain no
// digit, and sign-up forms reject those. Rejection sampling keeps the
// output uniform over the strings that satisfy the requirement.
export const DEFAULTS: Settings = {
  tab: "password",
  password: {
    length: 20,
    charsetId: "alphanum-v1",
    exclude: "",
    requiredClasses: ["lower", "upper", "digit"],
    allowWeak: false,
  },
  passphrase: { words: 8, separator: "-", capitalize: false, digitSuffix: false },
  secret: { bytes: 32, encoding: "base64url", prefix: "" },
  apiKey: { prefix: "sk", separator: "_", length: 32 },
  pin: { digits: 6, acknowledgeLowEntropy: false },
};

// Upper bounds for the popup. The core enforces its own (larger) limits and
// its entropy floors; these only keep the output usable in a popup.
export const LIMITS = {
  passwordLength: { min: 1, max: 256 },
  passphraseWords: { min: 1, max: 32 },
  secretBytes: { min: 1, max: 1024 },
  apiKeyLength: { min: 1, max: 256 },
  pinDigits: { min: 4, max: 32 },
} as const;

const KEY = "settings.v1";

function int(v: unknown, fallback: number, range: { min: number; max: number }): number {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
  return Math.min(range.max, Math.max(range.min, Math.trunc(n)));
}

function str(v: unknown, fallback: string, maxLength: number): string {
  return typeof v === "string" ? v.slice(0, maxLength) : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback;
}

function section(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/** Returns a fully-typed Settings object from any input, filling defaults. */
export function sanitize(raw: unknown): Settings {
  const r = section(raw);
  const pw = section(r.password);
  const pp = section(r.passphrase);
  const sc = section(r.secret);
  const ak = section(r.apiKey);
  const pn = section(r.pin);
  const d = DEFAULTS;

  const classes = Array.isArray(pw.requiredClasses)
    ? CHAR_CLASSES.filter((c) => (pw.requiredClasses as unknown[]).includes(c))
    : [...d.password.requiredClasses];
  const charsetId = str(pw.charsetId, d.password.charsetId, 64);

  return {
    tab: oneOf(r.tab, TABS, d.tab),
    password: {
      length: int(pw.length, d.password.length, LIMITS.passwordLength),
      charsetId: /^[a-z0-9-]+$/.test(charsetId) ? charsetId : d.password.charsetId,
      exclude: str(pw.exclude, d.password.exclude, 128),
      requiredClasses: classes,
      allowWeak: bool(pw.allowWeak, d.password.allowWeak),
    },
    passphrase: {
      words: int(pp.words, d.passphrase.words, LIMITS.passphraseWords),
      separator: str(pp.separator, d.passphrase.separator, 8),
      capitalize: bool(pp.capitalize, d.passphrase.capitalize),
      digitSuffix: bool(pp.digitSuffix, d.passphrase.digitSuffix),
    },
    secret: {
      bytes: int(sc.bytes, d.secret.bytes, LIMITS.secretBytes),
      encoding: oneOf(sc.encoding, ENCODINGS, "base64url"),
      prefix: str(sc.prefix, d.secret.prefix, 64),
    },
    apiKey: {
      prefix: str(ak.prefix, d.apiKey.prefix, 32),
      separator: str(ak.separator, d.apiKey.separator, 4),
      length: int(ak.length, d.apiKey.length, LIMITS.apiKeyLength),
    },
    pin: {
      digits: int(pn.digits, d.pin.digits, LIMITS.pinDigits),
      acknowledgeLowEntropy: bool(pn.acknowledgeLowEntropy, d.pin.acknowledgeLowEntropy),
    },
  };
}

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(KEY);
  return sanitize(stored[KEY]);
}

export async function saveSettings(s: Settings): Promise<void> {
  await chrome.storage.local.set({ [KEY]: sanitize(s) });
}

/**
 * Maps settings to the option object the Go binding expects. Always pass
 * the result of sanitize(): the bindings do not tolerate wrong types.
 */
export function bindingOptions(kind: Kind, s: Settings): Record<string, unknown> {
  switch (kind) {
    case "password":
      return {
        length: s.password.length,
        charsetId: s.password.charsetId,
        exclude: s.password.exclude,
        requiredClasses: s.password.requiredClasses.join(","),
        allowWeak: s.password.allowWeak,
      };
    case "passphrase":
      return { ...s.passphrase };
    case "secret":
      return { ...s.secret };
    case "apiKey":
      return { ...s.apiKey };
    case "pin":
      return { ...s.pin };
  }
}
