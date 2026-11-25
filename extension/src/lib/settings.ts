// User-chosen generator options. Persisted in chrome.storage.local so the
// popup reopens with the last configuration and the context menu / keyboard
// shortcut use the same settings. Generated values are never stored.

export type Kind = "password" | "passphrase" | "secret" | "apiKey" | "pin";

export type Settings = {
  tab: Kind | "entropy";
  password: {
    length: number;
    charsetId: string;
    exclude: string;
    requiredClasses: string[];
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

// Mirrors the CLI defaults documented in docs/SUBCOMMANDS.md.
export const DEFAULTS: Settings = {
  tab: "password",
  password: { length: 20, charsetId: "alphanum-v1", exclude: "", requiredClasses: [] },
  passphrase: { words: 8, separator: "-", capitalize: false, digitSuffix: false },
  secret: { bytes: 32, encoding: "base64url", prefix: "" },
  apiKey: { prefix: "sk", separator: "_", length: 32 },
  pin: { digits: 6, acknowledgeLowEntropy: false },
};

const KEY = "settings.v1";

export async function loadSettings(): Promise<Settings> {
  const raw = (await chrome.storage.local.get(KEY))[KEY] as Partial<Settings> | undefined;
  return merge(DEFAULTS, raw ?? {});
}

export async function saveSettings(s: Settings): Promise<void> {
  await chrome.storage.local.set({ [KEY]: s });
}

// Shallow per-section merge so new fields added in later versions pick up
// their defaults instead of becoming undefined.
function merge(base: Settings, over: Partial<Settings>): Settings {
  const out = structuredClone(base) as Record<string, unknown>;
  for (const [k, v] of Object.entries(over)) {
    const cur = out[k];
    if (cur && typeof cur === "object" && !Array.isArray(cur) && v && typeof v === "object") {
      out[k] = { ...cur, ...v };
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as Settings;
}

/** Maps stored settings to the option object the Go binding expects. */
export function bindingOptions(kind: Kind, s: Settings): Record<string, unknown> {
  switch (kind) {
    case "password":
      return {
        length: s.password.length,
        charsetId: s.password.charsetId,
        exclude: s.password.exclude,
        requiredClasses: s.password.requiredClasses.join(","),
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
