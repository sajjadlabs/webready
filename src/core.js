// Pure helpers shared by the Node and browser builds.
//
// Nothing here may import a Node built-in or touch a browser global: the
// browser entry (src/browser/index.js) imports this file directly.

/** Sizes at most three significant digits: 404 B, 40 KB, 402 KB, 4.01 MB, 1.16 GB. */
export function formatBytes(bytes) {
  const n = Math.abs(Number(bytes) || 0);
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${Number(value.toPrecision(3))} ${units[i]}`;
}

/** H.264 requires even dimensions. */
export const evenize = (n) => Math.max(2, n - (n % 2));

/**
 * Decide which rendition widths to generate for a source of `originalWidth`.
 * - Never upscales.
 * - Caps the largest rendition at min(originalWidth, largest breakpoint).
 * - Always produces at least one width.
 *
 * pickWidths(1600, [640, 1024, 1440, 1920]) -> [640, 1024, 1440, 1600]
 * pickWidths(500,  [640, 1024, 1440, 1920]) -> [500]
 * pickWidths(3000, [640, 1024, 1440, 1920]) -> [640, 1024, 1440, 1920]
 */
export function pickWidths(originalWidth, breakpoints, { even = false } = {}) {
  const sorted = [...new Set(breakpoints)].sort((a, b) => a - b);
  const maxBp = sorted[sorted.length - 1] ?? originalWidth;
  const cap = Math.min(originalWidth, maxBp);
  let widths = sorted.filter((w) => w < cap);
  widths.push(cap);
  if (even) widths = widths.map(evenize);
  return [...new Set(widths)].sort((a, b) => a - b);
}

/** Tiny promise pool — same worker pattern as the original WebP tool. */
export async function runPool(items, limit, task) {
  let next = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: size }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await task(items[i], i);
    }
  });
  await Promise.all(workers);
}

/** Manifest/snippet paths should always use forward slashes, even on Windows. */
export const toPosix = (p) => p.split("\\").join("/");
