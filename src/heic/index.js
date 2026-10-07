// webready/heic
//
// HEIC and HEIF photos - the iPhone's camera format - for compressImage, in
// the browsers that can't read them: all but Safari. The decoding is done by
// heic-to (libheif built for the browser), which you install yourself:
//
//   npm i heic-to
//
// Pass it as compressImage's fallback decoder, loaded lazily, so the decoder
// downloads only when a photo the browser can't read actually turns up:
//
//   compressImage(file, {
//     decode: (f) => import("webready/heic").then((heic) => heic.decodeHeic(f)),
//   });
//
// If your Content-Security-Policy forbids eval, write the same few lines
// with heic-to's "heic-to/csp" build.

/**
 * Decode a HEIC/HEIF photo into a JPEG the browser can read. The JPEG is an
 * intermediate step, so its quality is high; compressImage then resizes and
 * re-encodes it.
 *
 * @param {Blob} file
 * @param {{quality?: number}} [options]
 * @returns {Promise<Blob>}
 * @throws an error with `code: "decode_failed"` if the file isn't HEIC/HEIF
 */
export async function decodeHeic(file, { quality = 0.92 } = {}) {
  const { heicTo, isHeic } = await import("heic-to");
  if (!(await isHeic(file))) {
    throw Object.assign(new Error("Not a HEIC or HEIF image"), { code: "decode_failed" });
  }
  return heicTo({ blob: file, type: "image/jpeg", quality });
}
