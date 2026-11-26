import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import zlib from "node:zlib";
import { ZIP_EPOCH, createZip, dosDateTime, zipTimestamp } from "../../scripts/zip.mjs";
import { zipEntries } from "./helpers.mjs";

const text = Buffer.from("secretgenerator ".repeat(200));
// Hash output does not compress, like the PNG icons, and is the same on
// every run.
const noise = Buffer.concat(
  Array.from({ length: 16 }, (_, i) => createHash("sha256").update(String(i)).digest()),
);
const FILES = [
  { name: "manifest.json", data: Buffer.from('{"manifest_version":3}\n') },
  { name: "popup/popup.js", data: text },
  { name: "icons/icon-16.png", data: noise },
  { name: "_locales/pt_BR/messages.json", data: Buffer.from("{}\n") },
  { name: "empty.txt", data: Buffer.alloc(0) },
];

describe("createZip", () => {
  test("gives the same bytes for the same files in any order", () => {
    const a = createZip(FILES);
    const b = createZip([...FILES].reverse());
    assert.ok(a.equals(b));
  });

  test("sorts entries by path and keeps the content intact", () => {
    const entries = zipEntries(createZip(FILES));
    assert.deepEqual(
      entries.map((entry) => entry.name),
      [
        "_locales/pt_BR/messages.json",
        "empty.txt",
        "icons/icon-16.png",
        "manifest.json",
        "popup/popup.js",
      ],
    );
    for (const entry of entries) {
      const original = FILES.find((file) => file.name === entry.name).data;
      assert.ok(entry.data.equals(original), entry.name);
      assert.equal(entry.size, original.length, entry.name);
      assert.equal(entry.crc32, zlib.crc32(original), entry.name);
    }
  });

  test("deflates what shrinks and stores what does not", () => {
    const byName = Object.fromEntries(zipEntries(createZip(FILES)).map((e) => [e.name, e]));
    assert.equal(byName["popup/popup.js"].method, 8);
    assert.equal(byName["icons/icon-16.png"].method, 0);
    assert.equal(byName["empty.txt"].method, 0);
  });

  test("gives every entry the same timestamp and mode 0644", () => {
    for (const entry of zipEntries(createZip(FILES))) {
      // 1980-01-01 00:00:00
      assert.equal(entry.date, (1 << 5) | 1, entry.name);
      assert.equal(entry.time, 0, entry.name);
      assert.equal(entry.mode, 0o100644, entry.name);
      // Host system 3 is Unix; readers ignore the mode otherwise.
      assert.equal(entry.madeBy >> 8, 3, entry.name);
    }
  });

  test("takes the timestamp from the caller", () => {
    const at = Date.UTC(2026, 10, 26, 13, 45, 58) / 1000;
    const [entry] = zipEntries(createZip(FILES, { epochSeconds: at }));
    assert.equal(entry.date, ((2026 - 1980) << 9) | (11 << 5) | 26);
    assert.equal(entry.time, (13 << 11) | (45 << 5) | 29);
    assert.equal(createZip(FILES, { epochSeconds: at }).equals(createZip(FILES)), false);
  });

  test("rejects names that could escape or collide when unpacked", () => {
    const data = Buffer.from("x");
    for (const name of [
      "",
      "/abs.js",
      "../up.js",
      "a/../b.js",
      "a//b.js",
      "a\\b.js",
      "./a.js",
      "dir/",
    ]) {
      assert.throws(
        () => createZip([{ name, data }]),
        /invalid zip entry name/,
        JSON.stringify(name),
      );
    }
    assert.throws(
      () =>
        createZip([
          { name: "a.js", data },
          { name: "a.js", data },
        ]),
      /duplicate zip entry/,
    );
  });

  test("marks non-ASCII names as UTF-8 and leaves ASCII names unmarked", () => {
    const entries = zipEntries(
      createZip([
        { name: "a.txt", data: Buffer.from("a") },
        { name: "ação.txt", data: Buffer.from("b") },
      ]),
    );
    assert.deepEqual(
      entries.map((entry) => [entry.name, entry.flags]),
      [
        ["a.txt", 0],
        ["ação.txt", 0x0800],
      ],
    );
  });

  // An independent reader has the last word on whether the archive is valid.
  test("is accepted by unzip or by Python's zipfile", (t) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "secretgenerator-zip-"));
    try {
      const file = path.join(dir, "test.zip");
      writeFileSync(file, createZip(FILES));
      const readers = [
        ["unzip", ["-t", file]],
        ["python3", ["-m", "zipfile", "-t", file]],
      ];
      const results = readers
        .map(([command, args]) => spawnSync(command, args, { encoding: "utf8" }))
        .filter((result) => !result.error);
      if (results.length === 0) return t.skip("neither unzip nor python3 is installed");
      for (const result of results) assert.equal(result.status, 0, result.stdout + result.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("zip timestamps", () => {
  test("default to the zip epoch", () => {
    assert.equal(ZIP_EPOCH, Date.UTC(1980, 0, 1) / 1000);
    assert.equal(zipTimestamp({}), ZIP_EPOCH);
    assert.equal(zipTimestamp({ SOURCE_DATE_EPOCH: "" }), ZIP_EPOCH);
  });

  test("follow SOURCE_DATE_EPOCH, within what the format can hold", () => {
    assert.equal(zipTimestamp({ SOURCE_DATE_EPOCH: "1795700000" }), 1795700000);
    // Before 1980 the format has no representation.
    assert.equal(zipTimestamp({ SOURCE_DATE_EPOCH: "0" }), ZIP_EPOCH);
    assert.equal(
      zipTimestamp({ SOURCE_DATE_EPOCH: "99999999999" }),
      Date.UTC(2107, 11, 31, 23, 59, 58) / 1000,
    );
  });

  test("reject a SOURCE_DATE_EPOCH that is not a number of seconds", () => {
    for (const bad of ["yesterday", "-5", "1.5", "2026-11-26", " 12"]) {
      assert.throws(() => zipTimestamp({ SOURCE_DATE_EPOCH: bad }), /SOURCE_DATE_EPOCH/, bad);
    }
  });

  test("are encoded in UTC with two-second resolution", () => {
    assert.deepEqual(dosDateTime(ZIP_EPOCH), { date: 33, time: 0 });
    assert.deepEqual(dosDateTime(Date.UTC(1999, 11, 31, 23, 59, 59) / 1000), {
      date: (19 << 9) | (12 << 5) | 31,
      time: (23 << 11) | (59 << 5) | 29,
    });
  });
});
