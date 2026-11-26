#!/usr/bin/env node
// Starts a built WASM core in Node and prints what it reports about
// itself, as one line of JSON.
//
//   node scripts/probe-wasm.mjs <directory with keygen.wasm and wasm_exec.js>
//
// This is the only check that runs the binary together with its shim. A
// shim from another toolchain fails here, at instantiation, and so does a
// core whose identity was not stamped at link time; neither can be seen by
// looking at the files. It is a separate program because the Go runtime
// never returns control and installs globals of its own.
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dir = path.resolve(process.argv[2] ?? "");

// Both shims only install a `Go` constructor on the global object.
await import(pathToFileURL(path.join(dir, "wasm_exec.js")).href);
if (typeof globalThis.Go !== "function") throw new Error("wasm_exec.js did not install Go");

const go = new globalThis.Go();
const { instance } = await WebAssembly.instantiate(
  readFileSync(path.join(dir, "keygen.wasm")),
  go.importObject,
);
// main() installs the bindings and then parks forever, so the promise
// stays pending. It settles only if the program exits.
go.run(instance);
const core = globalThis.secretgen;
if (!core) throw new Error("the core started but did not install its bindings");

// The same call the extension makes for its default password. Only the
// length leaves this process.
const sample = core.password({
  length: 20,
  charsetId: "alphanum-v1",
  exclude: "",
  requiredClasses: "lower,upper,digit",
  allowWeak: false,
});
if (typeof sample?.password !== "string") {
  throw new Error(`the core did not generate a password: ${sample?.error ?? "no result"}`);
}

process.stdout.write(
  `${JSON.stringify({
    version: core.version,
    schemaVersion: core.schemaVersion,
    charsets: core.charsets().length,
    sampleLength: sample.password.length,
  })}\n`,
);
// The parked Go runtime would otherwise keep the process alive.
process.exit(0);
