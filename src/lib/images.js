import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { pickWidths, runPool, toPosix } from "../core.js";

// One encoder per format. AVIF effort runs 0–9, WebP's 0–6.
const ENCODERS = {
  avif: (pipeline, { quality, effort, lossless }) => pipeline.avif({ quality, effort, lossless }),
  webp: (pipeline, { quality, effort, lossless }) =>
    pipeline.webp({ quality, effort: Math.min(effort, 6), lossless }),
};

/**
 * Encode one image as renditions at `settings.widths`, in every format of
 * `settings.images.formats`. Never upscales: the largest rendition is capped
 * at the source's width. Animated images keep their first frame.
 *
 * @param {{full: string, rel: string}} file
 * @param {string} outDir
 * @param {object} settings  from resolveOptions()
 * @returns manifest entry { type, source, width, height, formats, renditions }
 */
export async function optimizeImage(file, outDir, settings) {
  const { formats, quality, effort, lossless } = settings.images;

  const meta = await sharp(file.full).metadata();
  const frameHeight = meta.pageHeight ?? meta.height;
  if (!meta.width || !frameHeight) throw new Error("Can't read this image's dimensions");
  // EXIF orientations 5–8 swap width and height once applied.
  const turned = (meta.orientation ?? 1) >= 5;
  const width = turned ? frameHeight : meta.width;
  const height = turned ? meta.width : frameHeight;

  const parsed = path.posix.parse(file.rel);
  fs.mkdirSync(path.join(outDir, parsed.dir), { recursive: true });

  const renditions = [];
  for (const target of pickWidths(width, settings.widths)) {
    // Decode and resize once per width; each format encodes from a clone.
    const base = sharp(file.full).rotate().resize({ width: target, withoutEnlargement: true });
    for (const format of formats) {
      const rel = toPosix(path.posix.join(parsed.dir, `${parsed.name}-${target}.${format}`));
      const info = await ENCODERS[format](base.clone(), {
        quality: quality[format],
        effort,
        lossless,
      }).toFile(path.join(outDir, rel));
      renditions.push({ format, width: info.width, height: info.height, bytes: info.size, file: rel });
    }
  }

  return { type: "image", source: file.rel, width, height, formats: [...formats], renditions };
}

/**
 * Encode many images in parallel. Failures are collected, not thrown.
 * @returns {Promise<{entries: object[], errors: {source: string, message: string}[]}>}
 */
export async function optimizeImages(files, outDir, settings, { concurrency = settings.concurrency, onFile } = {}) {
  const entries = [];
  const errors = [];
  await runPool(files, concurrency, async (file) => {
    try {
      const entry = await optimizeImage(file, outDir, settings);
      entries.push(entry);
      onFile?.({ file, entry });
    } catch (error) {
      errors.push({ source: file.rel, message: String(error.message || error) });
      onFile?.({ file, error });
    }
  });
  return { entries, errors };
}
