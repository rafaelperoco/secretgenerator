// Shared by the unit tests. They run against the output of `npm run build`
// (build/ and dist/), which `npm test` produces first.
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";
import { EXT_ROOT } from "../../scripts/common.mjs";

export { EXT_ROOT };
export const fromRoot = (...parts) => path.join(EXT_ROOT, ...parts);

/** Imports a module that tsc emitted, e.g. importBuilt("lib/settings.js"). */
export async function importBuilt(file) {
  const full = fromRoot("build", "js", file);
  if (!existsSync(full)) throw new Error(`${full} does not exist. Run \`npm run build\` first.`);
  return import(pathToFileURL(full).href);
}

/**
 * Reads the central directory of a zip. Written independently of
 * scripts/zip.mjs so the tests do not check the writer against itself.
 */
export function zipEntries(zip) {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error("no end-of-central-directory record");
  const count = zip.readUInt16LE(end + 10);
  const entries = [];
  let at = zip.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error(`bad central header at ${at}`);
    const nameLength = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    // The local header repeats the name and may have its own extra field.
    const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const compressedSize = zip.readUInt32LE(at + 20);
    const method = zip.readUInt16LE(at + 10);
    const body = zip.subarray(dataStart, dataStart + compressedSize);
    entries.push({
      name: zip.toString("utf8", at + 46, at + 46 + nameLength),
      madeBy: zip.readUInt16LE(at + 4),
      flags: zip.readUInt16LE(at + 8),
      method,
      time: zip.readUInt16LE(at + 12),
      date: zip.readUInt16LE(at + 14),
      crc32: zip.readUInt32LE(at + 16),
      size: zip.readUInt32LE(at + 24),
      mode: zip.readUInt32LE(at + 38) >>> 16,
      data: method === 0 ? Buffer.from(body) : zlib.inflateRawSync(body),
    });
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return entries;
}
