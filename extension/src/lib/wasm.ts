// Loads the secretgenerator WASM core inside any extension context: the
// popup page, the Chrome service worker or the Firefox background page.
// All generation happens locally; the extension makes no network calls.
//
// wasm_exec.js is imported statically because module service workers forbid
// dynamic import(). It only installs a `Go` constructor on globalThis. The
// build pairs it with the compiler that produced keygen.wasm (TinyGo's shim
// with a TinyGo binary, Go's shim with a GOOS=js binary); they are not
// interchangeable.
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

/** Bindings that take an options object and return a schema-v1 result. */
export type ResultBinding = "password" | "secret" | "passphrase" | "apiKey" | "pin" | "entropy";

type GoInstance = {
  run: (instance: WebAssembly.Instance) => Promise<void>;
  importObject: WebAssembly.Imports;
};

type HostGlobal = typeof globalThis & {
  Go?: new () => GoInstance;
  secretgen?: GoBindings;
};

const host = globalThis as HostGlobal;
let loading: Promise<GoBindings> | null = null;

// Forget the current instance so the next call instantiates a fresh one.
// Needed because a Go program that exits (a panic in a binding, for
// example) leaves its bindings on globalThis, where they only throw.
function reset(): void {
  loading = null;
  delete host.secretgen;
}

/** Instantiates keygen.wasm once per context and returns its bindings. */
export function loadBindings(): Promise<GoBindings> {
  if (loading) return loading;
  const attempt = (async () => {
    if (!host.Go) throw new Error("wasm_exec.js did not install Go");
    const go = new host.Go();
    const resp = await fetch(chrome.runtime.getURL("wasm/keygen.wasm"));
    if (!resp.ok) throw new Error(`keygen.wasm: HTTP ${resp.status}`);
    const { instance } = await WebAssembly.instantiate(
      await resp.arrayBuffer(),
      go.importObject,
    );
    // main() parks forever to keep the callback table alive, so run() must
    // never be awaited. It settles only if the program exits or crashes.
    const invalidate = () => {
      if (loading === attempt) reset();
    };
    go.run(instance).then(invalidate, invalidate);
    // run() executes main() synchronously up to its first park, so the
    // bindings are installed by the time it returns.
    if (!host.secretgen) throw new Error("WASM ran but did not expose secretgen");
    return host.secretgen;
  })();
  loading = attempt;
  attempt.catch(() => {
    if (loading === attempt) reset();
  });
  return attempt;
}

// A wrong-typed option makes syscall/js panic. Under standard Go the
// program then exits and every later call fails; under TinyGo the call
// traps. Either way: drop the instance and report a plain error. Callers
// validate options first (see settings.ts), so this is a last resort.
function fatal(): never {
  reset();
  throw new Error("The generator core stopped unexpectedly. Try again.");
}

/** Calls a result-returning binding; throws on the {error} shape. */
export async function callBinding(name: ResultBinding, opts: Opts): Promise<Result> {
  const bindings = await loadBindings();
  let out: ResultOrError | undefined;
  try {
    out = bindings[name](opts);
  } catch {
    fatal();
  }
  if (out === undefined || out === null || typeof out !== "object") fatal();
  if ("error" in out) throw new Error(out.error);
  return out;
}

/** Time-to-break estimates for an entropy value, one per attacker profile. */
export async function crackTimes(bits: number): Promise<CrackTimeEstimate[]> {
  if (typeof bits !== "number" || !Number.isFinite(bits)) return [];
  const bindings = await loadBindings();
  try {
    const out = bindings.crackTimes(bits);
    return Array.isArray(out) ? out : fatal();
  } catch {
    return fatal();
  }
}

/** Named charset ids, sorted (the core returns them in map order). */
export async function charsetIds(): Promise<string[]> {
  const bindings = await loadBindings();
  try {
    const out = bindings.charsets();
    return Array.isArray(out) ? [...out].sort() : fatal();
  } catch {
    return fatal();
  }
}

/** Identity string stamped into the core at build time. */
export async function coreVersion(): Promise<string> {
  return (await loadBindings()).version;
}
