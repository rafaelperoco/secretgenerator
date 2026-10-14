import assert from "node:assert/strict";
import test from "node:test";
import { releaseTag, unsafeArchiveMember } from "../dist/archive.js";

test("releaseTag accepts semver tags and bare versions", () => {
  assert.equal(releaseTag("v2.0.0"), "v2.0.0");
  assert.equal(releaseTag("2.0.0"), "v2.0.0");
  assert.equal(releaseTag("v2.0.0-alpha.11"), "v2.0.0-alpha.11");
});

test("releaseTag rejects path and shell metacharacters", () => {
  for (const bad of [
    "../other",
    "v2.0.0/../../evil",
    "v1'; calc; '",
    "v1.0.0 && curl https://example.invalid",
    "v1.0.0\nfoo",
    "",
    "latest",
  ]) {
    assert.throws(() => releaseTag(bad), /refusing release version/);
  }
});

test("unsafeArchiveMember allows the goreleaser layout", () => {
  for (const name of [
    "secretgenerator",
    "./secretgenerator",
    "LICENSE",
    "README.md",
    "schemas/output-v1.json",
    "docs/AUDIT.md",
    "docs/SCHEMA.md",
  ]) {
    assert.equal(unsafeArchiveMember(name, "secretgenerator"), null, name);
  }
  assert.equal(unsafeArchiveMember("secretgenerator.exe", "secretgenerator.exe"), null);
});

test("unsafeArchiveMember rejects traversal and unexpected files", () => {
  const cases = [
    ["../secretgenerator", "unsafe path"],
    ["/etc/passwd", "absolute path"],
    ["docs/../../etc/passwd", "unsafe path"],
    ["secretgenerator/../../../tmp/x", "unsafe path"],
    ["C:/Windows/system32/cmd.exe", "absolute path"],
    ["evil.sh", "unexpected member"],
    ["docs/../evil", "unsafe path"],
  ];
  for (const [name, reason] of cases) {
    const got = unsafeArchiveMember(name, "secretgenerator");
    assert.ok(got && got.includes(reason), `${name} => ${got}`);
  }
});
