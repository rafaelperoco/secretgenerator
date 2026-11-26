#!/usr/bin/env node
// Builds the unpacked extension into dist/<target>/.
//
//   node scripts/build.mjs [--target chrome|firefox|all]
//                          [--compiler auto|tinygo|go] [--version X.Y.Z]
//
// There is no bundler. tsc emits ES modules that the browser loads as they
// are, static/ is copied verbatim and the WASM core is compiled from the
// Go sources of this repository.
//
// The output is a pure function of the source tree and the toolchain:
// nothing from the clock or from git goes into it. Reviewers at
// addons.mozilla.org rebuild the package from source and compare.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  BuildError,
  EXT_ROOT,
  REPO_ROOT,
  readJson,
  resolveTargets,
  runCli,
  sha256,
  walkFiles,
} from "./common.mjs";
import { buildManifest, parseVersion } from "./manifest.mjs";
import { requireValidDist } from "./verify.mjs";

const USAGE =
  "usage: node scripts/build.mjs [--target chrome|firefox|all] [--compiler auto|tinygo|go] [--version X.Y.Z]";

// The manifest and popup.html load what is built from these. They are
// checked up front because tsc compiles happily without them: a missing
// source would only show at the end, as a file that is absent from dist/.
const ENTRY_FILES = [
  "src/background.ts",
  "src/popup/popup.ts",
  "static/popup/popup.html",
  "static/popup/popup.css",
];

const JS_DIR = path.join(EXT_ROOT, "build", "js");
const WASM_DIR = path.join(EXT_ROOT, "build", "wasm");
const STATIC_DIR = path.join(EXT_ROOT, "static");

const log = (message) => console.log(`[build] ${message}`);
const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;

function readOptions() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        target: { type: "string", default: "all" },
        compiler: { type: "string", default: "auto" },
        version: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (error) {
    throw new BuildError(`${error.message}\n${USAGE}`);
  }
  if (values.help) return { help: true };
  if (!["auto", "tinygo", "go"].includes(values.compiler)) {
    throw new BuildError(`unknown compiler "${values.compiler}" (expected auto, tinygo or go)`);
  }
  // package.json is the single source of the version. Release builds pass
  // the tag instead, because the tag is what the release is named after.
  const version = values.version ?? readJson(path.join(EXT_ROOT, "package.json")).version;
  try {
    return {
      targets: resolveTargets(values.target),
      compiler: values.compiler,
      version: parseVersion(version),
    };
  } catch (error) {
    throw new BuildError(error.message);
  }
}

function checkEntryFiles() {
  const missing = ENTRY_FILES.filter((file) => !existsSync(path.join(EXT_ROOT, file)));
  if (missing.length > 0) {
    throw new BuildError(
      `missing entry file${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}\n` +
        "The manifest and the popup page load what is built from them.",
    );
  }
}

function compileTypeScript() {
  // The pinned compiler from node_modules, located by path: module
  // resolution would also accept a global install of another version, and
  // the emitted JavaScript is part of what reviewers compare.
  const packageFile = path.join(EXT_ROOT, "node_modules", "typescript", "package.json");
  if (!existsSync(packageFile)) {
    throw new BuildError("node_modules/typescript is missing. Run `npm ci` in extension/ first.");
  }
  const tsc = path.resolve(path.dirname(packageFile), readJson(packageFile).bin.tsc);

  // tsc does not remove the output of sources that were deleted or renamed.
  rmSync(JS_DIR, { recursive: true, force: true });
  log("tsc -p tsconfig.json");
  const result = spawnSync(
    process.execPath,
    [tsc, "-p", "tsconfig.json", "--outDir", JS_DIR, "--noEmitOnError"],
    { cwd: EXT_ROOT, stdio: "inherit" },
  );
  if (result.error) throw new BuildError(`could not run tsc: ${result.error.message}`);
  if (result.status !== 0) throw new BuildError("TypeScript reported errors (see above)");
}

// Every toolchain command runs in the repository root: go.mod there
// selects the Go toolchain, so `go env GOROOT` names a different
// installation when it is asked from another directory.
function capture(command, args) {
  const result = spawnSync(command, args, { cwd: REPO_ROOT, encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

function run(command, args, env) {
  log(`${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (result.error) throw new BuildError(`could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) throw new BuildError(`${command} failed with status ${result.status}`);
}

function chooseCompiler(requested) {
  const tinygo = capture("tinygo", ["version"]);
  if (requested === "tinygo" && !tinygo) {
    throw new BuildError(
      "--compiler tinygo: TinyGo is not on PATH. Install it, or build a development package with --compiler go.",
    );
  }
  if (requested !== "go" && tinygo) return { compiler: "tinygo", compilerVersion: tinygo };

  const go = capture("go", ["version"]);
  if (!go) {
    throw new BuildError("neither TinyGo nor Go is on PATH; one is needed for the WASM core");
  }
  if (requested === "auto") {
    const rule = "=".repeat(68);
    console.warn(
      [
        rule,
        "WARNING: TinyGo is not on PATH. The WASM core is built with standard Go.",
        "This is a DEVELOPMENT build: keygen.wasm is about 3 MB instead of about",
        "0.5 MB. Release packages must be built with TinyGo; `npm run package`",
        "refuses this build unless --allow-dev-build is given.",
        rule,
      ]
        .map((line) => `[build] ${line}`)
        .join("\n"),
    );
  } else {
    log("standard Go was requested: this is a development build, not a release build");
  }
  return { compiler: "go", compilerVersion: go };
}

/**
 * Runs the freshly built core once, with its shim, and checks the identity
 * it reports. The files alone do not show a shim that belongs to another
 * toolchain or a link flag that was ignored.
 */
function checkCore(compiler, expected) {
  const probe = path.join(EXT_ROOT, "scripts", "probe-wasm.mjs");
  const result = spawnSync(process.execPath, [probe, WASM_DIR], {
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.error || result.status !== 0) {
    const detail = (result.stderr || result.error?.message || "").trim();
    throw new BuildError(`keygen.wasm does not run with its wasm_exec.js:\n${detail}`);
  }
  let version;
  try {
    // The last line: anything the Go program prints itself comes first.
    ({ version } = JSON.parse(result.stdout.trim().split("\n").pop()));
  } catch {
    throw new BuildError(`unexpected output from probe-wasm.mjs:\n${result.stdout}`);
  }
  if (version !== expected) {
    // tinygo/testdata/ldflags.go: "only globals without an initializer can
    // be replaced this way".
    const hint =
      compiler === "tinygo"
        ? "\nTinyGo applies -X only to a string variable that has no initializer in the Go source."
        : "";
    throw new BuildError(
      `the WASM core reports its version as "${version}" instead of "${expected}".\n` +
        `The link flag -X main.browserVersion did not take effect.${hint}`,
    );
  }
}

/** Compiles ./web/wasm into build/wasm/ next to the shim of the same toolchain. */
function buildWasm(requested, version) {
  const { compiler, compilerVersion } = chooseCompiler(requested);
  const goVersion = capture("go", ["env", "GOVERSION"]);
  if (!goVersion) {
    throw new BuildError("`go env GOVERSION` failed; TinyGo needs Go on PATH as well");
  }

  rmSync(WASM_DIR, { recursive: true, force: true });
  mkdirSync(WASM_DIR, { recursive: true });
  const wasm = path.join(WASM_DIR, "keygen.wasm");
  // Reported in the "version" field of every result the core returns.
  const identity = `secretgenerator-extension@${version.full}`;
  const stamp = `-X main.browserVersion=${identity}`;

  // The shim is the other half of the binary's ABI and has to come from
  // the toolchain that compiled it. A mismatched pair fails to instantiate.
  let shim;
  if (compiler === "tinygo") {
    run("tinygo", [
      "build",
      "-o",
      wasm,
      "-target",
      "wasm",
      "-no-debug",
      "-ldflags",
      stamp,
      "./web/wasm",
    ]);
    shim = path.join(capture("tinygo", ["env", "TINYGOROOT"]) ?? "", "targets", "wasm_exec.js");
  } else {
    run(
      "go",
      [
        "build",
        "-trimpath",
        // Go otherwise records the commit hash, the commit time and a
        // dirty flag in the binary, which would tie the output to git state.
        "-buildvcs=false",
        "-ldflags",
        `-s -w ${stamp}`,
        "-o",
        wasm,
        "./web/wasm",
      ],
      { GOOS: "js", GOARCH: "wasm" },
    );
    shim = path.join(capture("go", ["env", "GOROOT"]) ?? "", "lib", "wasm", "wasm_exec.js");
  }
  if (!existsSync(shim)) throw new BuildError(`the ${compiler} shim was not found at ${shim}`);
  copyFileSync(shim, path.join(WASM_DIR, "wasm_exec.js"));
  checkCore(compiler, identity);

  // Stays in build/: package.mjs reads it to tell a release build from a
  // development build and to detect a dist/ that is out of date.
  const info = {
    version: version.full,
    compiler,
    compilerVersion,
    goVersion,
    sha256: {
      "keygen.wasm": sha256(readFileSync(wasm)),
      "wasm_exec.js": sha256(readFileSync(path.join(WASM_DIR, "wasm_exec.js"))),
    },
  };
  writeFileSync(path.join(WASM_DIR, "build-info.json"), `${JSON.stringify(info, null, 2)}\n`);
  log(`keygen.wasm: ${mib(statSync(wasm).size)}, ${compilerVersion}`);
}

// static/ holds a few things that are sources rather than shipped files:
// the icon artwork, and whatever editors and operating systems leave behind.
function shipped(file) {
  if (file === "icons/icon.svg") return false;
  if (file.split("/").some((part) => part.startsWith("."))) return false;
  return !file.endsWith(".map") && !file.endsWith(".ts");
}

function assemble(target, version) {
  const dist = path.join(EXT_ROOT, "dist", target);
  const written = new Set();
  const place = (file) => {
    // A static file with the name of a compiled one would silently win.
    if (written.has(file)) throw new BuildError(`dist/${target}/${file} would be written twice`);
    written.add(file);
    const to = path.join(dist, file);
    mkdirSync(path.dirname(to), { recursive: true });
    return to;
  };

  for (const file of walkFiles(JS_DIR)) {
    if (file.endsWith(".js")) copyFileSync(path.join(JS_DIR, file), place(file));
  }
  for (const file of walkFiles(STATIC_DIR)) {
    if (shipped(file)) copyFileSync(path.join(STATIC_DIR, file), place(file));
  }
  for (const file of ["keygen.wasm", "wasm_exec.js"]) {
    copyFileSync(path.join(WASM_DIR, file), place(`wasm/${file}`));
  }
  const manifest = buildManifest(target, version.full);
  writeFileSync(place("manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  requireValidDist(dist, `dist/${target}`);
  const bytes = [...written].reduce((sum, file) => sum + statSync(path.join(dist, file)).size, 0);
  log(`dist/${target}: ${written.size} files, ${mib(bytes)}, verified`);
}

runCli("build", () => {
  const options = readOptions();
  if (options.help) {
    console.log(USAGE);
    return;
  }
  checkEntryFiles();
  log(`version ${options.version.full}, target ${options.targets.join(" + ")}`);
  // Removed before the first step that can fail, so that a failed build
  // does not leave an older dist/ behind that looks like its result.
  for (const target of options.targets) {
    rmSync(path.join(EXT_ROOT, "dist", target), { recursive: true, force: true });
  }
  compileTypeScript();
  buildWasm(options.compiler, options.version);
  for (const target of options.targets) assemble(target, options.version);
});
