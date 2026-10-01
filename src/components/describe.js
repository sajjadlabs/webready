// What <Picture> and <Video> render, worked out without any framework, so
// the React and Vue components share it - and it can be tested on its own.
// Attribute names are HTML's (srcset, fetchpriority, playsinline); each
// component translates them to its framework's.

const groupFor = (kind) => (kind === "image" ? "images" : "videos");

/** The manifest entry for a source path such as "hero.jpg" or "./team/sara.png". */
export function findEntry(manifest, kind, src) {
  const key = String(src ?? "").replace(/^\.?\/+/, "");
  return manifest?.[groupFor(kind)]?.[key] ?? null;
}

/** A rendition's URL, under the manifest's publicPath when it has one. */
export function urlFor(manifest, file) {
  return manifest?.publicPath ? `${manifest.publicPath}/${file}` : file;
}

const isDev = () =>
  typeof process !== "undefined" && process.env && process.env.NODE_ENV !== "production";

const warned = new Set();
/** Warn once per message, in development only. */
export function warn(message) {
  if (!isDev() || warned.has(message)) return;
  warned.add(message);
  console.warn(`[webready] ${message}`);
}

/**
 * A <picture>: one <source> per format, and an <img> fallback - the largest
 * rendition in the most widely supported format, with its width and height
 * so the browser reserves the space.
 *
 * @returns {{sources: {type: string, srcset: string, sizes: string}[], img: object} | null}
 *   null when `src` isn't in the manifest.
 */
export function describePicture(manifest, src, { alt = "", sizes = "100vw", priority = false } = {}) {
  const entry = findEntry(manifest, "image", src);
  if (!entry) return null;
  if (!manifest.publicPath) warn("set publicPath in your webready config so the components can build URLs");

  const sources = entry.formats.map((format) => {
    const renditions = entry.renditions
      .filter((r) => r.format === format)
      .sort((a, b) => a.width - b.width);
    return {
      type: `image/${format}`,
      srcset: renditions.map((r) => `${urlFor(manifest, r.file)} ${r.width}w`).join(", "),
      sizes,
    };
  });

  const fallback = entry.renditions
    .filter((r) => r.format === entry.formats.at(-1))
    .sort((a, b) => a.width - b.width)
    .at(-1);

  const img = {
    src: urlFor(manifest, fallback.file),
    alt,
    width: fallback.width,
    height: fallback.height,
    // The first image on screen loads at once, and first.
    loading: priority ? "eager" : "lazy",
    decoding: "async",
  };
  if (priority) img.fetchpriority = "high";
  return { sources, img };
}

/**
 * A <video>: sources widest first, each but the last limited by a
 * min-width media query, and the poster. `controls` defaults to on unless
 * the video autoplays - autoplaying videos are usually decoration.
 *
 * @returns {{video: object, sources: {src: string, media: string|null, type: string}[]} | null}
 */
export function describeVideo(manifest, src, { autoplay = false, controls } = {}) {
  const entry = findEntry(manifest, "video", src);
  if (!entry) return null;
  if (!manifest.publicPath) warn("set publicPath in your webready config so the components can build URLs");

  const sorted = [...entry.renditions].sort((a, b) => b.width - a.width);
  const sources = sorted.map((r, i) => ({
    src: urlFor(manifest, r.file),
    media: i < sorted.length - 1 ? `(min-width: ${sorted[i + 1].width + 1}px)` : null,
    type: "video/mp4",
  }));

  const video = {
    width: entry.width,
    height: entry.height,
    preload: "metadata",
    playsinline: true,
    controls: controls ?? !autoplay,
  };
  if (autoplay) video.autoplay = true;
  if (entry.poster) video.poster = urlFor(manifest, entry.poster);
  return { video, sources };
}
