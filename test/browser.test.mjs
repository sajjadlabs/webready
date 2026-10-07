/**
 * Tests for the browser build (src/browser/index.js), run in Node.
 *
 * Node has no createImageBitmap or OffscreenCanvas, so these tests install
 * fakes that behave like the two engines that matter:
 *   - "chrome": encodes WebP;
 *   - "safari": asked for WebP, silently returns PNG.
 * The worker test runs the worker's source text in an isolated VM context
 * holding only what a real worker has, so any reference the pipeline makes
 * to the module around it fails loudly.
 *
 * Run with: node test/browser.test.mjs
 */
import vm from "node:vm";
import { resolveObjectURL } from "node:buffer";

let failures = 0;
const must = (cond, msg) => {
  if (cond) console.log(`  OK   ${msg}`);
  else { console.error(`  FAIL ${msg}`); failures++; }
};

// ── fakes ────────────────────────────────────────────────────────────────
const stats = { bitmaps: 0, closed: 0, draws: [], fills: [], canvases: [] };
let engine = "chrome";

/** A photo of the given size; the fake decoder reads its dimensions. */
// Real file headers, so the metadata check can read the fakes.
const segment = (marker, length) => [0xff, marker, (length + 2) >> 8, (length + 2) & 0xff, ...new Array(length).fill(0x20)];
const jpegHeader = ({ exif = false, icc = false } = {}) =>
  [0xff, 0xd8, ...segment(0xe0, 14), ...(icc ? segment(0xe2, 14) : []), ...(exif ? segment(0xe1, 30) : []), 0xff, 0xda];
const webpHeader = (flags) => {
  const chunk = flags === undefined ? "VP8 " : "VP8X";
  const bytes = [..."RIFF"].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], [..."WEBP"].map((c) => c.charCodeAt(0)), [...chunk].map((c) => c.charCodeAt(0)), [10, 0, 0, 0]);
  if (flags !== undefined) bytes.push(flags);
  return bytes;
};

/** A photo of the given size; the fake decoder reads its dimensions. */
function photo(name, type, width, height, bytes, extra = {}) {
  const data = new Uint8Array(bytes);
  if (type === "image/jpeg") data.set(jpegHeader(extra));
  if (type === "image/webp") data.set(webpHeader(extra.webpFlags));
  return Object.assign(new File([data], name, { type }), {
    __width: width, __height: height, ...extra,
  });
}

async function fakeCreateImageBitmap(file, options) {
  if (file.__rejectOptions && options) {
    throw Object.assign(new Error("bad option"), { name: "TypeError" });
  }
  if (file.__undecodable) {
    throw Object.assign(new Error("The source image could not be decoded."), { name: "InvalidStateError" });
  }
  stats.bitmaps++;
  return { width: file.__width, height: file.__height, close() { stats.closed++; } };
}

// Encoded size model, bytes per pixel: WebP beats JPEG; PNG is large.
const BYTES_PER_PIXEL = { "image/webp": 0.18, "image/jpeg": 0.25, "image/png": 1.5 };

class FakeOffscreenCanvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    stats.canvases.push(this);
  }
  getContext() {
    return {
      drawImage: (source, x, y, w, h) => stats.draws.push([source.width, source.height, w ?? source.width, h ?? source.height]),
      fillRect: () => stats.fills.push(this.fillStyle),
      set fillStyle(v) { stats.lastFill = v; },
    };
  }
  async convertToBlob({ type, quality = 1 }) {
    const supported = engine === "chrome" ? ["image/webp", "image/jpeg", "image/png"] : ["image/jpeg", "image/png"];
    const actual = supported.includes(type) ? type : "image/png";
    const lossy = actual === "image/png" ? 1 : quality;
    const size = Math.round(this.width * this.height * BYTES_PER_PIXEL[actual] * lossy);
    return new Blob([new Uint8Array(Math.max(1, size))], { type: actual });
  }
}

globalThis.createImageBitmap = fakeCreateImageBitmap;
globalThis.OffscreenCanvas = FakeOffscreenCanvas;

// A Worker that runs the real worker source in an isolated context.
class VmWorker {
  constructor(url) {
    this.onmessage = null;
    this.onerror = null;
    const self = {
      postMessage: (data) => queueMicrotask(() => this.onmessage?.({ data })),
      onmessage: null,
    };
    this.ready = resolveObjectURL(url).text().then((source) => {
      VmWorker.lastSource = source;
      const context = vm.createContext({
        self,
        createImageBitmap: fakeCreateImageBitmap,
        OffscreenCanvas: FakeOffscreenCanvas,
      });
      vm.runInContext(source, context);
      return self;
    });
    VmWorker.created++;
  }
  postMessage(data) {
    this.ready.then((self) => self.onmessage({ data }));
  }
  terminate() {}
}
VmWorker.created = 0;

// A Worker that fails to start, like one blocked by a Content-Security-Policy.
class BrokenWorker {
  constructor() {
    BrokenWorker.created++;
    queueMicrotask(() => this.onerror?.(new Event("error")));
  }
  postMessage() {}
  terminate() {}
}
BrokenWorker.created = 0;

// ── pure helpers ─────────────────────────────────────────────────────────
const lib = await import("../src/browser/index.js");
const { targetSize, outputName, toMimeType, compressImage, compressImages, canEncode } = lib;

console.log("helpers:");
must(JSON.stringify(targetSize(4032, 3024, 2560)) === '{"width":2560,"height":1920}', "landscape 12MP fits 2560 on the long side");
must(JSON.stringify(targetSize(3024, 4032, 2560)) === '{"width":1920,"height":2560}', "portrait fits 2560 on the long side");
must(JSON.stringify(targetSize(800, 600, 2560)) === '{"width":800,"height":600}', "never upscales");
must(outputName("IMG_1234.JPG", "image/webp") === "IMG_1234.webp", "output name takes the new extension");
must(outputName("no-extension", "image/jpeg") === "no-extension.jpg", "names without an extension still get one");
must(toMimeType("webp") === "image/webp" && toMimeType("image/avif") === "image/avif", "format names and MIME types both accepted");
let threw = false;
try { toMimeType("gif89"); } catch { threw = true; }
must(threw, "unknown formats are rejected");

// ── main-thread pipeline ─────────────────────────────────────────────────
console.log("main thread:");
const noWorker = { useWorker: false };
const bigJpeg = () => photo("IMG_1.JPG", "image/jpeg", 4032, 3024, 3_200_000);

engine = "chrome";
let r = await compressImage(bigJpeg(), noWorker);
must(r.type === "image/webp" && r.width === 2560 && r.height === 1920, "Chrome: 12MP JPEG -> 2560x1920 WebP");
must(r.file.name === "IMG_1.webp" && r.file.type === "image/webp" && !r.kept, "Chrome: a new File named .webp");
must(r.bytes < r.originalBytes / 4, `Chrome: much smaller (${(r.originalBytes / 1e6).toFixed(1)} MB -> ${(r.bytes / 1e6).toFixed(2)} MB)`);

engine = "safari";
stats.fills = [];
r = await compressImage(bigJpeg(), noWorker);
must(r.type === "image/jpeg" && r.file.name === "IMG_1.jpg", "Safari: WebP comes back as PNG, so JPEG is used instead");
must(stats.fills.length > 0 && stats.lastFill === "#fff", "Safari: transparent areas go on white before JPEG");

engine = "chrome";
stats.draws = [];
await compressImage(bigJpeg(), { ...noWorker, maxDimension: 1000 });
const widths = stats.draws.map((d) => d[2]);
must(JSON.stringify(widths) === "[2016,1008,1000]", `large reductions step down by halves (${widths.join(" -> ")})`);

r = await compressImage(photo("portrait.jpeg", "image/jpeg", 3024, 4032, 3_000_000), noWorker);
must(r.width === 1920 && r.height === 2560, "portrait orientation kept");

const smallJpeg = () => photo("thumb.jpeg", "image/jpeg", 800, 600, 40_000);
r = await compressImage(smallJpeg(), noWorker);
must(r.kept && r.file.name === "thumb.jpeg" && r.bytes === 40_000, "an already-small JPEG is kept when re-encoding would grow it");
r = await compressImage(smallJpeg(), { ...noWorker, keepOriginalIfSmaller: false });
must(!r.kept && r.type === "image/webp", "...unless keepOriginalIfSmaller is false (to always strip metadata)");

r = await compressImage(photo("scan.png", "image/png", 1000, 800, 900_000), noWorker);
must(!r.kept && r.type === "image/webp", "a PNG is re-encoded even when small: PNG isn't an accepted output");

let error = null;
try { await compressImage(photo("IMG_9.HEIC", "image/heic", 4032, 3024, 2_000_000, { __undecodable: true }), noWorker); }
catch (e) { error = e; }
must(error?.code === "decode_failed", "an undecodable image (HEIC in Chrome) fails with code decode_failed");

r = await compressImage(photo("old.jpeg", "image/jpeg", 3000, 2000, 2_000_000, { __rejectOptions: true }), noWorker);
must(r.type === "image/webp", "engines that reject the imageOrientation option are retried without it");

must(stats.bitmaps === stats.closed, `every decoded bitmap is closed (${stats.closed}/${stats.bitmaps})`);
must(stats.canvases.every((c) => c.width === 0 && c.height === 0), `every canvas is released (${stats.canvases.length})`);

// ── batch ────────────────────────────────────────────────────────────────
console.log("batch:");
const progress = [];
const batch = await compressImages(
  [bigJpeg(), photo("bad.heic", "image/heic", 10, 10, 10, { __undecodable: true }), smallJpeg()],
  noWorker,
  { onProgress: (done, total, name) => progress.push(`${done}/${total} ${name}`) },
);
must(batch.entries.length === 2 && batch.errors.length === 1, "failures are collected, the rest still convert");
must(batch.errors[0].code === "decode_failed" && batch.errors[0].file.name === "bad.heic", "the error names its file and code");
must(batch.entries[0].source.name === "IMG_1.JPG" && batch.entries[1].source.name === "thumb.jpeg", "entries keep input order");
must(progress.length === 3 && progress[2].startsWith("3/3"), "progress reported for every file");

// ── keeping the original ─────────────────────────────────────────────────
// A 2000x1500 photo fits in 2560 px; as WebP the fakes encode it to 442,800 bytes.
console.log("keeping the original:");
const { hasMetadata } = lib;
const fitting = (bytes, extra) => photo("fits.jpeg", "image/jpeg", 2000, 1500, bytes, extra);
r = await compressImage(fitting(450_000), noWorker);
must(r.kept && r.bytes === 450_000, "a photo that fits is kept when re-encoding saves under 10% (here 1.6%)");
r = await compressImage(fitting(600_000), noWorker);
must(!r.kept && r.type === "image/webp", "...and converted when it saves more (here 26%)");
r = await compressImage(fitting(450_000, { exif: true }), noWorker);
must(!r.kept && r.type === "image/webp", "a photo with EXIF metadata is never kept: GPS must not slip through");
r = await compressImage(fitting(450_000), { ...noWorker, minSaving: 0 });
must(!r.kept, "minSaving: 0 converts whenever re-encoding is any smaller (1.0 behaviour)");
let rangeError = null;
try { await compressImage(fitting(450_000), { ...noWorker, minSaving: 1 }); } catch (e) { rangeError = e; }
must(rangeError instanceof RangeError, "minSaving must be below 1");
r = await compressImage(photo("fits.webp", "image/webp", 2000, 1500, 450_000), noWorker);
must(r.kept, "a simple WebP that fits is kept too");

console.log("hasMetadata:");
const bytesOf = (header, size = 400) => { const d = new Uint8Array(size); d.set(header); return new Blob([d]); };
must((await hasMetadata(bytesOf(jpegHeader()))) === false, "JPEG with only JFIF: none");
must((await hasMetadata(bytesOf(jpegHeader({ icc: true })))) === false, "JPEG with a colour profile: none (not personal)");
must((await hasMetadata(bytesOf(jpegHeader({ exif: true })))) === true, "JPEG with an APP1 segment (EXIF or XMP): yes");
must((await hasMetadata(bytesOf([0xff, 0xd8, ...segment(0xe0, 14)]))) === true, "JPEG cut off before its image data: not vouched for");
must((await hasMetadata(bytesOf(webpHeader()))) === false, "simple WebP: none");
must((await hasMetadata(bytesOf(webpHeader(0x10)))) === false, "extended WebP with only alpha: none");
must((await hasMetadata(bytesOf(webpHeader(0x08)))) === true && (await hasMetadata(bytesOf(webpHeader(0x04)))) === true, "extended WebP flagging EXIF or XMP: yes");
must((await hasMetadata(bytesOf([0x89, 0x50, 0x4e, 0x47]))) === true, "other formats: not vouched for");

console.log("decode (fallback decoder):");
const heic = () => photo("IMG_0001.HEIC", "image/heic", 4032, 3024, 2_000_000, { __undecodable: true });
const decodedJpeg = () => Object.assign(new Blob([new Uint8Array(10)], { type: "image/jpeg" }), { __width: 4032, __height: 3024 });
let decodeCalls = 0;
r = await compressImage(heic(), { ...noWorker, decode: async (f) => { decodeCalls++; must(f.name === "IMG_0001.HEIC", "the decoder gets the original file"); return decodedJpeg(); } });
must(r.type === "image/webp" && r.width === 2560 && r.height === 1920 && decodeCalls === 1, "an image the browser can't read is decoded, then shrunk as usual");
must(r.file.name === "IMG_0001.webp" && r.originalBytes === 2_000_000 && !r.kept, "named after the original, measured against it, never kept");
r = await compressImage(fitting(450_000), { ...noWorker, decode: async () => { decodeCalls++; return decodedJpeg(); } });
must(decodeCalls === 1, "the decoder is only called when the browser can't read the image");
error = null;
try { await compressImage(heic(), { ...noWorker, decode: async () => { throw new Error("libheif failed"); } }); } catch (e) { error = e; }
must(error?.code === "decode_failed" && error.cause?.message === "libheif failed", "if the decoder fails too: decode_failed, with its error as the cause");
error = null;
try { await compressImage(heic(), { ...noWorker, decode: async () => "nope" }); } catch (e) { error = e; }
must(error instanceof TypeError, "the decoder must return a Blob");

// ── worker ───────────────────────────────────────────────────────────────
console.log("worker:");
globalThis.Worker = VmWorker;
r = await compressImage(bigJpeg());
must(VmWorker.created === 1, "a worker is created on first use");
must(r.type === "image/webp" && r.width === 2560, "the worker, running only its own source text, converts the photo");
await compressImage(bigJpeg());
must(VmWorker.created === 1, "and is reused for the next photo");
error = null;
try { await compressImage(photo("bad.heic", "image/heic", 10, 10, 10, { __undecodable: true })); }
catch (e) { error = e; }
must(error?.code === "decode_failed", "worker errors keep their code across the message boundary");
must(!/\b(targetSize|outputName|toMimeType|runPool|DEFAULTS|hasMetadata)\b/.test(VmWorker.lastSource ?? ""), "the worker source references none of the module's helpers");
r = await compressImage(heic(), { decode: async () => decodedJpeg() });
must(r.type === "image/webp" && r.width === 2560, "the fallback decoder runs on the main thread; the worker shrinks its result");

// A fresh module instance, so the broken worker doesn't leak into the tests above.
const lib2 = await import("../src/browser/index.js?broken-worker");
globalThis.Worker = BrokenWorker;
r = await lib2.compressImage(bigJpeg());
must(r.type === "image/webp", "if the worker can't start (CSP), the photo is converted on the main thread");
await lib2.compressImage(bigJpeg());
must(BrokenWorker.created === 1, "...and no further workers are attempted on that page");

// ── canEncode ────────────────────────────────────────────────────────────
console.log("canEncode:");
must((await canEncode("webp")) === true, "reports WebP support (tested once, then cached)");
const lib3 = await import("../src/browser/index.js?safari");
engine = "safari";
must((await lib3.canEncode("webp")) === false, "Safari: WebP is not encodable");
must((await lib3.canEncode("jpeg")) === true, "Safari: JPEG is");

console.log(failures ? `\n${failures} FAILED` : "\nAll good ✅");
process.exit(failures ? 1 : 0);
