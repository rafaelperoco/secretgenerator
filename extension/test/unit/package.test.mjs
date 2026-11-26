// Runs scripts/package.mjs for real, on a copy of the build in a temporary
// directory. The script finds the extension from its own location, so the
// copy lets the tests change build-info.json and dist/ without touching
// the working tree or its artifacts/.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { readJson, sha256, walkFiles } from "../../scripts/common.mjs";
import { parseVersion } from "../../scripts/manifest.mjs";
import { fromRoot, zipEntries } from "./helpers.mjs";

const scratch = mkdtempSync(path.join(os.tmpdir(), "secretgenerator-package-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const realInfo = readJson(fromRoot("build", "wasm", "build-info.json"));
const version = parseVersion(realInfo.version);

let counter = 0;
/** A copy of scripts/, dist/ and build-info.json, optionally claiming another compiler. */
function workspace(compiler = realInfo.compiler) {
  const root = path.join(scratch, String(counter++));
  cpSync(fromRoot("scripts"), path.join(root, "scripts"), { recursive: true });
  cpSync(fromRoot("dist"), path.join(root, "dist"), { recursive: true });
  const info = path.join(root, "build", "wasm", "build-info.json");
  cpSync(fromRoot("build", "wasm", "build-info.json"), info);
  writeFileSync(info, `${JSON.stringify({ ...realInfo, compiler }, null, 2)}\n`);
  return {
    root,
    artifacts: path.join(root, "artifacts"),
    run: (args = [], env = {}) => {
      // An inherited SOURCE_DATE_EPOCH would change the expected timestamps.
      const { SOURCE_DATE_EPOCH: _inherited, ...clean } = process.env;
      return spawnSync(process.execPath, [path.join(root, "scripts", "package.mjs"), ...args], {
        encoding: "utf8",
        env: { ...clean, ...env },
      });
    },
  };
}

const zipName = (target) => `secretgenerator-extension-${version.full}-${target}.zip`;
const hashes = (dir) =>
  Object.fromEntries(
    readdirSync(dir).map((file) => [file, sha256(readFileSync(path.join(dir, file)))]),
  );

describe("npm run package", () => {
  test("writes byte-identical zips and checksums on two consecutive runs", () => {
    const ws = workspace();
    const first = ws.run(["--allow-dev-build"]);
    assert.equal(first.status, 0, first.stderr);
    const before = hashes(ws.artifacts);
    assert.deepEqual(Object.keys(before).sort(), [
      "SHA256SUMS",
      zipName("chrome"),
      zipName("firefox"),
    ]);

    // Moved away so the second run cannot pass by leaving the files alone.
    renameSync(ws.artifacts, `${ws.artifacts}-first`);
    const second = ws.run(["--allow-dev-build"]);
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(hashes(ws.artifacts), before);
  });

  test("puts manifest.json at the zip root, with exactly the files of dist/", () => {
    const ws = workspace();
    assert.equal(ws.run(["--allow-dev-build"]).status, 0);
    for (const target of ["chrome", "firefox"]) {
      const entries = zipEntries(readFileSync(path.join(ws.artifacts, zipName(target))));
      const names = entries.map((entry) => entry.name);
      assert.ok(names.includes("manifest.json"), target);
      assert.deepEqual(names, walkFiles(path.join(ws.root, "dist", target)), target);
      for (const entry of entries) {
        const original = readFileSync(path.join(ws.root, "dist", target, entry.name));
        assert.ok(entry.data.equals(original), `${target}: ${entry.name}`);
        assert.equal(entry.date, (1 << 5) | 1, `${target}: ${entry.name} date`);
        assert.equal(entry.time, 0, `${target}: ${entry.name} time`);
        assert.equal(entry.mode, 0o100644, `${target}: ${entry.name} mode`);
      }
      const manifest = JSON.parse(entries.find((entry) => entry.name === "manifest.json").data);
      assert.equal(manifest.version, version.manifest);
    }
  });

  test("writes zips that unzip or Python's zipfile accept", (t) => {
    const ws = workspace();
    assert.equal(ws.run(["--allow-dev-build"]).status, 0);
    let checked = 0;
    for (const target of ["chrome", "firefox"]) {
      const file = path.join(ws.artifacts, zipName(target));
      for (const [command, args] of [
        ["unzip", ["-t", file]],
        ["python3", ["-m", "zipfile", "-t", file]],
      ]) {
        const result = spawnSync(command, args, { encoding: "utf8" });
        if (result.error) continue;
        assert.equal(result.status, 0, `${command}: ${result.stdout}${result.stderr}`);
        checked++;
      }
    }
    if (checked === 0) t.skip("neither unzip nor python3 is installed");
  });

  test("lists every zip in SHA256SUMS in sha256sum format", () => {
    const ws = workspace();
    assert.equal(ws.run(["--allow-dev-build"]).status, 0);
    const expected = ["chrome", "firefox"]
      .map((target) => {
        const name = zipName(target);
        return `${sha256(readFileSync(path.join(ws.artifacts, name)))}  ${name}\n`;
      })
      .join("");
    assert.equal(readFileSync(path.join(ws.artifacts, "SHA256SUMS"), "utf8"), expected);
  });

  test("packages one target and keeps the other zip in the checksums", () => {
    const ws = workspace();
    assert.equal(ws.run(["--allow-dev-build"]).status, 0);
    const before = hashes(ws.artifacts);
    rmSync(path.join(ws.artifacts, zipName("firefox")));
    const result = ws.run(["--allow-dev-build", "--target", "firefox"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(hashes(ws.artifacts), before);
  });

  test("refuses a standard-Go build unless --allow-dev-build is given", () => {
    const ws = workspace("go");
    const refused = ws.run();
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /development build/);
    assert.match(refused.stderr, /--allow-dev-build/);
    assert.equal(existsSync(ws.artifacts), false, "nothing may be written");

    const allowed = ws.run(["--allow-dev-build"]);
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.match(allowed.stderr, /DEVELOPMENT build/);
  });

  test("packages a TinyGo build without the flag", () => {
    const ws = workspace("tinygo");
    const result = ws.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.ok(existsSync(path.join(ws.artifacts, zipName("chrome"))));
  });

  // The check on the real build, whatever compiler produced it.
  test("treats the build in the working tree according to its compiler", () => {
    const result = workspace().run();
    if (realInfo.compiler === "tinygo") assert.equal(result.status, 0, result.stderr);
    else assert.match(result.stderr, /development build/);
  });

  test("refuses a dist/ that does not match build-info.json", () => {
    const changedCore = workspace("tinygo");
    appendFileSync(path.join(changedCore.root, "dist", "chrome", "wasm", "keygen.wasm"), "x");
    const first = changedCore.run();
    assert.equal(first.status, 1);
    assert.match(first.stderr, /dist\/chrome is out of date \(wasm\/keygen\.wasm differs/);
    assert.equal(existsSync(changedCore.artifacts), false, "nothing may be written");

    const otherVersion = workspace("tinygo");
    const info = path.join(otherVersion.root, "build", "wasm", "build-info.json");
    writeFileSync(info, JSON.stringify({ ...realInfo, compiler: "tinygo", version: "9.9.9" }));
    const second = otherVersion.run();
    assert.equal(second.status, 1);
    assert.match(second.stderr, /is out of date \(its manifest version is not 9\.9\.9\)/);
  });

  test("refuses a dist/ that fails verification, and a build that is missing", () => {
    const broken = workspace("tinygo");
    rmSync(path.join(broken.root, "dist", "firefox", "lib", "fill.js"));
    const first = broken.run();
    assert.equal(first.status, 1);
    assert.match(first.stderr, /dist\/firefox failed verification/);
    assert.match(first.stderr, /import "\.\/fill\.js" does not resolve to a file/);
    assert.equal(existsSync(broken.artifacts), false, "the chrome zip must not be written either");

    const unbuilt = workspace("tinygo");
    rmSync(path.join(unbuilt.root, "build"), { recursive: true });
    const second = unbuilt.run();
    assert.equal(second.status, 1);
    assert.match(second.stderr, /build-info\.json is missing\. Run `npm run build` first/);

    const noDist = workspace("tinygo");
    rmSync(path.join(noDist.root, "dist", "chrome"), { recursive: true });
    const third = noDist.run();
    assert.equal(third.status, 1);
    assert.match(third.stderr, /dist\/chrome is missing/);
  });

  test("uses SOURCE_DATE_EPOCH for the entry timestamps when it is set", () => {
    const ws = workspace("tinygo");
    const at = Date.UTC(2026, 10, 26, 12, 0, 0) / 1000;
    assert.equal(ws.run([], { SOURCE_DATE_EPOCH: String(at) }).status, 0);
    for (const entry of zipEntries(readFileSync(path.join(ws.artifacts, zipName("chrome"))))) {
      assert.equal(entry.date, ((2026 - 1980) << 9) | (11 << 5) | 26, entry.name);
      assert.equal(entry.time, 12 << 11, entry.name);
    }
    const invalid = ws.run([], { SOURCE_DATE_EPOCH: "today" });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /SOURCE_DATE_EPOCH/);
  });

  test("rejects options it does not know", () => {
    const ws = workspace("tinygo");
    const target = ws.run(["--target", "safari"]);
    assert.equal(target.status, 1);
    assert.match(target.stderr, /unknown target "safari"/);
    const option = ws.run(["--sign"]);
    assert.equal(option.status, 1);
    assert.match(option.stderr, /Unknown option '--sign'/);
    assert.equal(existsSync(ws.artifacts), false);
  });
});
