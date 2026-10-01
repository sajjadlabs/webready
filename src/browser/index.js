// webready/browser
//
// Shrink photos in the browser before uploading them:
//
//   import { compressImage } from "webready/browser";
//   const { file } = await compressImage(input, { maxDimension: 2560 });
//
// Each image is decoded with its EXIF orientation applied, scaled down so its
// longer side fits `maxDimension` (never up), and re-encoded. Re-encoding drops
// all metadata, GPS coordinates included.
//
// Output is WebP by default. Safari cannot encode WebP from a canvas - it
// silently returns PNG instead - so whenever the encoder hands back a
// different type, the image is encoded again in `fallbackFormat` (JPEG by
// default). On iPhones that means every browser, since they all use Safari's
// engine.
//
// The work runs in a Web Worker when OffscreenCanvas is available, and on the
// main thread otherwise. The worker is created from this module's own source
// text - no separate file, so no bundler configuration - which needs a build
// target that keeps async functions native (ES2017 or later).
//
// Nothing here touches a browser global at import time, so the module can be
// imported during server rendering.

import { runPool } from "../core.js";

export const DEFAULTS = Object.freeze({
  maxDimension: 2560,
  format: "webp",
  fallbackFormat: "jpeg",
  quality: 0.82,
  // When the input already fits, is in an accepted format, and re-encoding
  // doesn't make it smaller, return the input untouched. Note that such a
  // kept file also keeps its metadata.
  keepOriginalIfSmaller: true,
  useWorker: true,
});

const MIME_TYPES = {
  webp: "image/webp",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  avif: "image/avif",
};

const EXTENSIONS = {
  "image/webp": "webp",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/avif": "avif",
};

/** "webp" -> "image/webp"; a full MIME type passes through. */
export function toMimeType(format) {
  const type = MIME_TYPES[String(format).toLowerCase()] ??
    (String(format).startsWith("image/") ? String(format) : null);
  if (!type) throw new Error(`Unknown image format "${format}"`);
  return type;
}

/** The size an image of width x height is scaled to. Never upscales. */
export function targetSize(width, height, maxDimension) {
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** "IMG_1234.JPG" + "image/webp" -> "IMG_1234.webp" */
export function outputName(name, type) {
  const base = String(name || "").replace(/\.[^./\\]*$/, "") || "image";
  return `${base}.${EXTENSIONS[type] ?? type.split("/")[1]}`;
}

// ---------------------------------------------------------------------------
// The pipeline. It must stay SELF-CONTAINED - no reference to anything
// outside its own body - because the worker is built from its source text.
// It runs the same way in the worker and on the main thread.
// ---------------------------------------------------------------------------
async function shrinkImage(file, settings) {
  const { maxDimension, type, fallbackType, quality } = settings;

  const fail = (code, message) => {
    const error = new Error(message);
    error.code = code;
    return error;
  };
  const makeCanvas = (width, height) => {
    if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  };
  const context = (canvas) => {
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    return ctx;
  };
  const encode = (canvas, mime) =>
    canvas.convertToBlob
      ? canvas.convertToBlob({ type: mime, quality })
      : new Promise((resolve, reject) =>
          canvas.toBlob(
            (blob) => (blob ? resolve(blob) : reject(fail("encode_failed", "Encoding failed"))),
            mime,
            quality,
          ),
        );
  // Setting a canvas to 0x0 frees its pixels at once - Safari holds on to
  // them otherwise.
  const release = (canvas) => {
    canvas.width = 0;
    canvas.height = 0;
  };

  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch (error) {
    // Engines that don't know the option reject it with a TypeError; they
    // apply the EXIF orientation by default anyway.
    if (error && error.name === "TypeError") {
      try {
        bitmap = await createImageBitmap(file);
      } catch {
        bitmap = null;
      }
    }
    if (!bitmap) {
      throw fail("decode_failed", "This browser cannot read this image (HEIC, for example)");
    }
  }

  try {
    const sourceWidth = bitmap.width;
    const sourceHeight = bitmap.height;
    const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));

    // Halve in steps while more than a 2x reduction remains: one large
    // drawImage downscale turns fine detail into moiré.
    let source = bitmap;
    let stepWidth = sourceWidth;
    let stepHeight = sourceHeight;
    let previous = null;
    while (stepWidth / 2 > width) {
      stepWidth = Math.round(stepWidth / 2);
      stepHeight = Math.round(stepHeight / 2);
      const step = makeCanvas(stepWidth, stepHeight);
      context(step).drawImage(source, 0, 0, stepWidth, stepHeight);
      if (previous) release(previous);
      previous = step;
      source = step;
    }

    const canvas = makeCanvas(width, height);
    context(canvas).drawImage(source, 0, 0, width, height);
    if (previous) release(previous);

    // JPEG has no transparency: transparent pixels would turn black, so
    // they go on white first.
    const flatten = () => {
      const flat = makeCanvas(width, height);
      const ctx = context(flat);
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(canvas, 0, 0);
      return flat;
    };
    const encodeAs = async (mime) => {
      if (mime !== "image/jpeg") return encode(canvas, mime);
      const flat = flatten();
      try {
        return await encode(flat, mime);
      } finally {
        release(flat);
      }
    };

    let blob = await encodeAs(type);
    // A browser that can't encode `type` returns PNG instead of failing.
    if (blob.type !== type && fallbackType && fallbackType !== type) {
      blob = await encodeAs(fallbackType);
    }
    release(canvas);

    return { blob, width, height, sourceWidth, sourceHeight };
  } finally {
    if (bitmap.close) bitmap.close();
  }
}

// ---------------------------------------------------------------------------
// The worker: one per page, created on first use. Jobs are matched to their
// answers by id.
// ---------------------------------------------------------------------------
const WORKER_SOURCE = `const shrinkImage = ${shrinkImage.toString()};
self.onmessage = async (event) => {
  const { id, file, settings } = event.data;
  try {
    const result = await shrinkImage(file, settings);
    self.postMessage({ id, ok: true, result });
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      code: (error && error.code) || "failed",
      message: String((error && error.message) || error),
    });
  }
};`;

let worker = null;
let workerUrl = null;
let workerBroken = false;
let nextJobId = 0;
const jobs = new Map();

function workerSupported() {
  return (
    !workerBroken &&
    typeof Worker !== "undefined" &&
    typeof OffscreenCanvas !== "undefined" &&
    typeof createImageBitmap !== "undefined"
  );
}

function getWorker() {
  if (worker) return worker;
  workerUrl = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
  worker = new Worker(workerUrl);

  worker.onmessage = (event) => {
    // The script has loaded, so its URL can go.
    if (workerUrl) {
      URL.revokeObjectURL(workerUrl);
      workerUrl = null;
    }
    const { id, ok, result, code, message } = event.data;
    const job = jobs.get(id);
    if (!job) return;
    jobs.delete(id);
    if (ok) {
      job.resolve(result);
    } else {
      const error = new Error(message);
      error.code = code;
      job.reject(error);
    }
  };

  // The worker couldn't start - a Content-Security-Policy without `blob:`
  // workers, for instance. Hand its jobs back to run on the main thread, and
  // stop trying workers on this page.
  worker.onerror = () => {
    workerBroken = true;
    worker.terminate();
    worker = null;
    for (const job of jobs.values()) {
      const error = new Error("The worker could not start");
      error.workerFailure = true;
      job.reject(error);
    }
    jobs.clear();
  };

  return worker;
}

function runInWorker(file, settings) {
  return new Promise((resolve, reject) => {
    const id = ++nextJobId;
    jobs.set(id, { resolve, reject });
    getWorker().postMessage({ id, file, settings });
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const encodeSupport = new Map();

/**
 * Whether this browser can encode `format` ("webp", "avif", "image/jpeg"…).
 * Tested once per format by encoding a 1x1 image and checking what comes back.
 * @returns {Promise<boolean>}
 */
export function canEncode(format) {
  const type = toMimeType(format);
  if (!encodeSupport.has(type)) {
    encodeSupport.set(
      type,
      (async () => {
        try {
          const canvas =
            typeof OffscreenCanvas !== "undefined"
              ? new OffscreenCanvas(1, 1)
              : Object.assign(document.createElement("canvas"), { width: 1, height: 1 });
          canvas.getContext("2d").fillRect(0, 0, 1, 1);
          const blob = canvas.convertToBlob
            ? await canvas.convertToBlob({ type })
            : await new Promise((resolve) => canvas.toBlob(resolve, type));
          return blob?.type === type;
        } catch {
          return false;
        }
      })(),
    );
  }
  return encodeSupport.get(type);
}

/**
 * Shrink one image.
 *
 * @param {File|Blob} file
 * @param {Partial<typeof DEFAULTS>} [options]
 * @returns {Promise<{file: File, width: number, height: number, type: string,
 *   sourceWidth: number, sourceHeight: number, originalBytes: number,
 *   bytes: number, kept: boolean}>}
 *   `width`/`height` are the output's, `sourceWidth`/`sourceHeight` the
 *   input's (after EXIF rotation). `kept` is true when the input was
 *   returned untouched.
 * @throws an Error with `code` "decode_failed" when the browser can't read the image.
 */
export async function compressImage(file, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const type = toMimeType(opts.format);
  const fallbackType = opts.fallbackFormat ? toMimeType(opts.fallbackFormat) : null;
  const settings = { maxDimension: opts.maxDimension, type, fallbackType, quality: opts.quality };

  let result;
  if (opts.useWorker && workerSupported()) {
    try {
      result = await runInWorker(file, settings);
    } catch (error) {
      if (!error.workerFailure) throw error;
      result = await shrinkImage(file, settings);
    }
  } else {
    result = await shrinkImage(file, settings);
  }

  const { blob, width, height, sourceWidth, sourceHeight } = result;
  const fits = Math.max(sourceWidth, sourceHeight) <= opts.maxDimension;
  const accepted = file.type === type || file.type === fallbackType;
  if (opts.keepOriginalIfSmaller && fits && accepted && blob.size >= file.size) {
    return {
      file,
      width: sourceWidth,
      height: sourceHeight,
      type: file.type,
      sourceWidth,
      sourceHeight,
      originalBytes: file.size,
      bytes: file.size,
      kept: true,
    };
  }

  const output = new File([blob], outputName(file.name, blob.type), {
    type: blob.type,
    lastModified: Date.now(),
  });
  return {
    file: output,
    width,
    height,
    type: blob.type,
    sourceWidth,
    sourceHeight,
    originalBytes: file.size,
    bytes: output.size,
    kept: false,
  };
}

/**
 * Shrink many images. Failures are collected, not thrown. One at a time by default - decoding a phone photo
 * takes tens of megabytes of memory.
 *
 * @returns {Promise<{entries: object[], errors: {file: File, code: string, message: string}[]}>}
 *   Each entry is compressImage's result plus `source`, the input file.
 */
export async function compressImages(files, options = {}, { concurrency = 1, onProgress } = {}) {
  const list = Array.from(files);
  const entries = new Array(list.length);
  const errors = [];
  let done = 0;

  await runPool(list, concurrency, async (file, index) => {
    try {
      entries[index] = { source: file, ...(await compressImage(file, options)) };
    } catch (error) {
      errors.push({ file, code: error.code ?? "failed", message: error.message });
    } finally {
      done++;
      onProgress?.(done, list.length, file.name);
    }
  });

  return { entries: entries.filter(Boolean), errors };
}
