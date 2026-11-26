// A minimal, deterministic zip writer. The same input always gives the
// same bytes: entries are sorted, carry one fixed timestamp and one fixed
// permission mode, and nothing from the file system or the clock is
// recorded. Store reviewers rebuild the package from source and compare.
//
// The compressed bytes come from Node's bundled zlib, so byte identity
// holds for a given Node version, not across all of them.
import zlib from "node:zlib";

/** 1980-01-01T00:00:00Z, the earliest time a zip entry can carry. */
export const ZIP_EPOCH = 315532800;
const ZIP_LATEST = Date.UTC(2107, 11, 31, 23, 59, 58) / 1000;

const VERSION_NEEDED = 20; // 2.0: DEFLATE
const MADE_BY_UNIX = (3 << 8) | VERSION_NEEDED;
// A regular file with mode 0644. Readers honour it only for the Unix host.
const FILE_ATTRIBUTES = (0o100644 << 16) >>> 0;
const UTF8_NAMES = 0x0800;

/**
 * The timestamp for every entry, in seconds since the Unix epoch:
 * SOURCE_DATE_EPOCH when set (https://reproducible-builds.org), otherwise
 * the zip epoch.
 */
export function zipTimestamp(env = process.env) {
  const raw = env.SOURCE_DATE_EPOCH;
  if (raw === undefined || raw === "") return ZIP_EPOCH;
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`SOURCE_DATE_EPOCH must be a whole number of seconds, got "${raw}"`);
  }
  return Math.min(ZIP_LATEST, Math.max(ZIP_EPOCH, Number(raw)));
}

/** MS-DOS date and time fields. Read as UTC so the result has no time zone in it. */
export function dosDateTime(epochSeconds) {
  const d = new Date(epochSeconds * 1000);
  return {
    date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
  };
}

function checkName(name) {
  const ok =
    typeof name === "string" &&
    name !== "" &&
    !name.includes("\\") &&
    name.split("/").every((part) => part !== "" && part !== "." && part !== "..");
  if (!ok) throw new Error(`invalid zip entry name ${JSON.stringify(name)}`);
}

/**
 * @param {{ name: string, data: Uint8Array }[]} files `name` is a relative
 *   path with "/" separators
 * @param {{ epochSeconds?: number }} [options]
 * @returns {Buffer} the archive
 */
export function createZip(files, { epochSeconds = ZIP_EPOCH } = {}) {
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  // The classic format is enough for an extension; zip64 is not written.
  if (sorted.length > 0xffff) throw new Error("too many entries for a zip without zip64");
  const { date, time } = dosDateTime(epochSeconds);

  const chunks = [];
  const directory = [];
  let offset = 0;
  let previous;
  for (const { name, data } of sorted) {
    checkName(name);
    if (name === previous) throw new Error(`duplicate zip entry "${name}"`);
    previous = name;

    const nameBytes = Buffer.from(name, "utf8");
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    // Already-compressed files (the PNG icons) only grow under DEFLATE.
    const stored = deflated.length >= data.length;
    const body = stored ? Buffer.from(data) : deflated;
    if (data.length > 0xffffffff || offset + body.length > 0xffffffff) {
      throw new Error(`"${name}" does not fit in a zip without zip64`);
    }

    // Local header and central directory entry share these 26 bytes.
    const common = Buffer.alloc(26);
    common.writeUInt16LE(VERSION_NEEDED, 0);
    common.writeUInt16LE(/^[\x20-\x7e]*$/.test(name) ? 0 : UTF8_NAMES, 2);
    common.writeUInt16LE(stored ? 0 : 8, 4);
    common.writeUInt16LE(time, 6);
    common.writeUInt16LE(date, 8);
    common.writeUInt32LE(zlib.crc32(data), 10);
    common.writeUInt32LE(body.length, 14);
    common.writeUInt32LE(data.length, 18);
    common.writeUInt16LE(nameBytes.length, 22);
    common.writeUInt16LE(0, 24); // extra field length

    const local = Buffer.alloc(4);
    local.writeUInt32LE(0x04034b50, 0);
    chunks.push(local, common, nameBytes, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(MADE_BY_UNIX, 4);
    common.copy(central, 6);
    // 32..37: comment length, disk number, internal attributes; all zero.
    central.writeUInt32LE(FILE_ATTRIBUTES, 38);
    central.writeUInt32LE(offset, 42);
    directory.push(central, nameBytes);

    offset += local.length + common.length + nameBytes.length + body.length;
  }

  const directorySize = directory.reduce((sum, chunk) => sum + chunk.length, 0);
  if (offset + directorySize > 0xffffffff) throw new Error("archive too large without zip64");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  // 4..7: disk numbers, zero.
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(offset, 16);
  // 20..21: archive comment length, zero.
  return Buffer.concat([...chunks, ...directory, end]);
}
