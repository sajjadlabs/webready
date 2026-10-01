// webready.json: the manifest of every source and its renditions, which
// doubles as the incremental-build cache.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const MANIFEST_FILE = "webready.json";
export const MARKUP_FILE = "webready.html";
export const MANIFEST_VERSION = 1;

export const VERSION = JSON.parse(
  fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
).version;

export function emptyManifest(publicPath = null) {
  return {
    version: MANIFEST_VERSION,
    generator: `webready@${VERSION}`,
    publicPath,
    images: {},
    videos: {},
  };
}

/** The manifest in `outDir`, or null if there is none or it can't be used. */
export function readManifest(outDir) {
  const file = path.join(outDir, MANIFEST_FILE);
  if (!fs.existsSync(file)) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    if (manifest?.version !== MANIFEST_VERSION) return null;
    manifest.images ??= {};
    manifest.videos ??= {};
    return manifest;
  } catch {
    // Unreadable: everything is re-encoded and the file rewritten.
    return null;
  }
}

export function writeManifest(outDir, manifest) {
  fs.mkdirSync(outDir, { recursive: true });
  const ordered = {
    ...manifest,
    images: sortKeys(manifest.images),
    videos: sortKeys(manifest.videos),
  };
  fs.writeFileSync(path.join(outDir, MANIFEST_FILE), `${JSON.stringify(ordered, null, 2)}\n`);
}

const sortKeys = (object) =>
  Object.fromEntries(Object.entries(object).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/**
 * A fingerprint of a source's content. When its size and modification time
 * match the previous run, the previous fingerprint is reused instead of
 * reading the whole file again - which matters for large videos.
 */
export async function fingerprint(file, previous) {
  if (
    previous?.fingerprint &&
    previous.sourceBytes === file.size &&
    previous.sourceMtimeMs === file.mtimeMs
  ) {
    return previous.fingerprint;
  }
  const hash = crypto.createHash("sha1");
  for await (const chunk of fs.createReadStream(file.full)) hash.update(chunk);
  return hash.digest("hex");
}

/** A key for the settings that shape a kind's outputs: change them and those sources re-encode. */
export function settingsKey(kind, settings) {
  const relevant =
    kind === "image"
      ? { widths: settings.widths, ...settings.images }
      : {
          widths: settings.widths,
          ...settings.videos,
          posterFormat: settings.images.formats.at(-1),
          posterQuality: settings.images.quality[settings.images.formats.at(-1)],
        };
  return crypto.createHash("sha1").update(JSON.stringify(relevant)).digest("hex").slice(0, 12);
}

/** Every file an entry owns, relative to the output folder. */
export function entryFiles(entry) {
  const files = entry.renditions.map((r) => r.file);
  if (entry.poster) files.push(entry.poster);
  return files;
}

export function outputsExist(outDir, entry) {
  return entryFiles(entry).every((file) => fs.existsSync(path.join(outDir, file)));
}

/** Delete files, then any folders left empty, up to (not including) outDir. */
export function removeFiles(outDir, files) {
  const removed = [];
  const dirs = new Set();
  for (const file of files) {
    const full = path.join(outDir, file);
    if (fs.existsSync(full)) {
      fs.rmSync(full, { force: true });
      removed.push(file);
    }
    dirs.add(path.dirname(full));
  }
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
    let current = dir;
    while (current.startsWith(outDir) && current !== outDir) {
      try {
        if (fs.readdirSync(current).length) break;
        fs.rmdirSync(current);
      } catch {
        break;
      }
      current = path.dirname(current);
    }
  }
  return removed;
}
