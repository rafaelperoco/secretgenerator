// Release-archive checks used by the postinstall downloader.
//
// The version string is interpolated into a GitHub download URL and, on
// the Windows fallback that used to exist, into a shell command. It has
// to be a semver tag and nothing else. Archive members are checked
// before extraction so a release tarball cannot write outside the
// destination via `..` or an absolute path.

const RELEASE_TAG =
  /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

const PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;

/** Returns a `vX.Y.Z` tag, or throws if `raw` is not a semver release tag. */
export function releaseTag(raw: string): string {
  const tag = raw.startsWith("v") ? raw : `v${raw}`;
  if (!RELEASE_TAG.test(tag)) {
    throw new Error(
      `refusing release version ${JSON.stringify(raw)}: expected a semver tag such as v2.0.0 or v2.0.0-alpha.11`
    );
  }
  return tag;
}

/**
 * Returns null when `name` is safe to extract next to the package, or a
 * short reason when it is not. `binary` is the expected executable name
 * (`secretgenerator` or `secretgenerator.exe`). Goreleaser also packs
 * LICENSE, README.md, schemas/, and docs/.
 */
export function unsafeArchiveMember(name: string, binary: string): string | null {
  let normalized = name.replace(/\\/g, "/");
  if (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  if (normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  if (normalized === "") {
    return null;
  }
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    return `absolute path ${JSON.stringify(name)}`;
  }
  const parts = normalized.split("/");
  for (const part of parts) {
    if (part === "" || part === "." || part === ".." || !PATH_SEGMENT.test(part)) {
      return `unsafe path ${JSON.stringify(name)}`;
    }
  }
  const rel = parts.join("/");
  if (
    rel === binary ||
    rel === "LICENSE" ||
    rel === "README.md" ||
    rel.startsWith("schemas/") ||
    rel.startsWith("docs/")
  ) {
    return null;
  }
  return `unexpected member ${JSON.stringify(name)}`;
}

/**
 * Windows CI puts Git's GNU tar first on PATH. That tar rejects zip
 * archives and treats `C:` as a remote host. The system bsdtar reads zip
 * and keeps drive letters local, so prefer it when it is installed.
 */
export function tarBinary(
  platform: NodeJS.Platform,
  systemTar: string,
  systemTarExists: boolean
): string {
  if (platform === "win32" && systemTarExists) return systemTar;
  return "tar";
}

/**
 * tar argv for extraction. A Windows drive prefix makes GNU tar treat the
 * path as a remote host (`Cannot connect to C`). Pass `gnuForceLocal` only
 * for that tar. The system bsdtar rejects `--force-local` and accepts the
 * drive letter. Same-drive callers should pass a path relative to the dest.
 */
export function tarExtractArgs(
  archiveArg: string,
  format: "tar.gz" | "zip",
  opts: { gnuForceLocal?: boolean } = {}
): string[] {
  const flag = format === "tar.gz" ? "-xzf" : "-xf";
  const args = [flag, archiveArg, "-C", "."];
  if (opts.gnuForceLocal && /^[A-Za-z]:/.test(archiveArg)) {
    return ["--force-local", ...args];
  }
  return args;
}
