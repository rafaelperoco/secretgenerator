// Loads the secretgenerator WASM core inside any extension context: the
// popup page, the Chrome service worker or the Firefox background page.
// All generation happens locally; the extension makes no network calls.
//
// wasm_exec.js is imported statically because service workers forbid
// dynamic import(). It only installs a `Go` constructor on globalThis.
import "../wasm/wasm_exec.js";

export type CrackTimeEstimate = {
  profile_id: string;
  description: string;
  seconds: number;
  human_readable: string;
};

export type Result = {
  schema_version: number;
  password?: string;
  length: number;
  charset_id: string;
  charset_size: number;
  entropy_bits: number;
  excluded_count?: number;
  excluded_sha256?: string;
  required_classes?: string;
  algorithm: string;
  subcommand: string;
  version: string;
  request_id: string;
  timestamp_utc: string;
  warnings?: string[];
};

type ResultOrError = Result | { error: string };
type Opts = Record<string, unknown>;

export type GoBindings = {
  password: (opts: Opts) => ResultOrError;
  secret: (opts: Opts) => ResultOrError;
  passphrase: (opts: Opts) => ResultOrError;
  apiKey: (opts: Opts) => ResultOrError;
  pin: (opts: Opts) => ResultOrError;
  entropy: (opts: Opts) => ResultOrError;
  charsets: () => string[];
  crackTimes: (bits: number) => CrackTimeEstimate[];
  schemaVersion: number;
  version: string;
};

type GoInstance = {
  run: (instance: WebAssembly.Instance) => Promise<void>;
  importObject: WebAssembly.Imports;
};

type HostGlobal = typeof globalThis & {
  Go?: new () => GoInstance;
  secretgen?: GoBindings;
};

let loading: Promise<GoBindings> | null = null;

/** Instantiates keygen.wasm once per context and returns its bindings. */
export function loadBindings(): Promise<GoBindings> {
  if (loading) return loading;
  loading = (async () => {
    const host = globalThis as HostGlobal;
    if (host.secretgen) return host.secretgen;
    if (!host.Go) throw new Error("wasm_exec.js did not install Go");

    const go = new host.Go();
    const resp = await fetch(chrome.runtime.getURL("wasm/keygen.wasm"));
    if (!resp.ok) throw new Error(`keygen.wasm: HTTP ${resp.status}`);
    const { instance } = await WebAssembly.instantiate(
      await resp.arrayBuffer(),
      go.importObject,
    );
    // main() blocks forever to keep the callback table alive: never await.
    void go.run(instance);
    await new Promise((r) => setTimeout(r, 0));
    if (!host.secretgen) throw new Error("WASM ran but did not expose secretgen");
    return host.secretgen;
  })();
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

/** Throws on the {error} shape returned by the Go bindings. */
export function unwrap(r: ResultOrError): Result {
  if ("error" in r) throw new Error(r.error);
  return r;
}
