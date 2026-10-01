import fs from "node:fs";
import path from "node:path";
import { toPosix } from "../core.js";

export const IMAGE_EXTS = new Set([
  ".jpg", ".jpeg", ".png", ".webp", ".avif", ".tiff", ".tif", ".gif",
]);

export const VIDEO_EXTS = new Set([".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi"]);

// A folder holding this file is a webready output folder: never scanned
// into, so outputs living under the input (public/media inside public/)
// aren't mistaken for sources.
const OUTPUT_MARKER = "webready.json";

// Media we recognise but can't convert, and what to do instead.
const UNSUPPORTED = {
  ".heic": "HEIC isn't supported — convert it to JPEG first",
  ".heif": "HEIF isn't supported — convert it to JPEG first",
  ".svg": "SVG is resolution-independent already",
  ".psd": "Photoshop files aren't supported — export a JPEG or PNG",
  ".bmp": "BMP isn't supported — convert it to PNG first",
  ".dng": "camera RAW isn't supported — export a JPEG first",
  ".cr2": "camera RAW isn't supported — export a JPEG first",
  ".nef": "camera RAW isn't supported — export a JPEG first",
  ".arw": "camera RAW isn't supported — export a JPEG first",
};

/**
 * Scan `inputDir` recursively.
 *
 * @param {string} inputDir
 * @param {{only?: "images"|"videos", exclude?: string[]}} [options]
 *   `exclude`: absolute folders to leave out, such as an output folder that
 *   lives inside the input. Folders containing a webready.json are always
 *   left out.
 * @returns {{images: object[], videos: object[], skipped: {source: string, reason: string}[], ignored: number}}
 *   Each file is { full, rel, size, mtimeMs }: `rel` is relative to inputDir,
 *   with forward slashes, so outputs can mirror the folder structure.
 */
export function scanMedia(inputDir, { only, exclude = [] } = {}) {
  const images = [];
  const videos = [];
  const skipped = [];
  let ignored = 0;
  const excluded = new Set(exclude.map((dir) => path.resolve(dir)));

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || excluded.has(full)) continue;
        if (fs.existsSync(path.join(full, OUTPUT_MARKER))) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name).toLowerCase();
      const rel = toPosix(path.relative(inputDir, full));
      const kind = IMAGE_EXTS.has(ext) ? "image" : VIDEO_EXTS.has(ext) ? "video" : null;

      if (!kind) {
        if (UNSUPPORTED[ext]) skipped.push({ source: rel, reason: UNSUPPORTED[ext] });
        else ignored++;
        continue;
      }
      if (only && only !== `${kind}s`) continue;

      const stat = fs.statSync(full);
      (kind === "image" ? images : videos).push({ full, rel, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  };

  walk(inputDir);
  const byRel = (a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);
  images.sort(byRel);
  videos.sort(byRel);
  skipped.sort((a, b) => (a.source < b.source ? -1 : 1));
  return { images, videos, skipped, ignored };
}

/**
 * Sources that would write the same output files: same folder, same name,
 * different extension (hero.jpg and hero.png). Compared case-insensitively,
 * because macOS and Windows treat Hero-640.avif and hero-640.avif as one file.
 * @returns {string[][]} groups of colliding source paths
 */
export function findCollisions({ images, videos }) {
  const groups = new Map();
  for (const [kind, files] of [["image", images], ["video", videos]]) {
    for (const file of files) {
      const parsed = path.posix.parse(file.rel);
      const key = `${kind}:${parsed.dir}/${parsed.name}`.toLowerCase();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(file.rel);
    }
  }
  return [...groups.values()].filter((group) => group.length > 1);
}
