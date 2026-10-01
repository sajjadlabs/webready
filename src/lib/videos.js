import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import sharp from "sharp";
import { pickWidths, toPosix } from "../core.js";

let cachedFfmpeg;
// ffmpeg-static is installed, but its install script never downloaded the
// binary: npm 12 skips dependencies' install scripts until they're approved.
let staticWithoutBinary = false;

/**
 * Find a working ffmpeg, in this order:
 *   1. the FFMPEG_PATH environment variable
 *   2. the optional `ffmpeg-static` package, if installed
 *   3. `ffmpeg` on the PATH
 * @returns {Promise<string|null>}
 */
export async function resolveFfmpeg() {
  if (cachedFfmpeg !== undefined) return cachedFfmpeg;

  const candidates = [];
  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH);
  try {
    const mod = await import("ffmpeg-static");
    const binary = mod?.default;
    if (binary && fs.existsSync(binary)) candidates.push(binary);
    else if (binary) staticWithoutBinary = true;
  } catch {
    /* optional peer dependency not installed */
  }
  candidates.push("ffmpeg");

  for (const candidate of candidates) {
    try {
      if (spawnSync(candidate, ["-version"], { stdio: "ignore" }).status === 0) {
        cachedFfmpeg = candidate;
        return cachedFfmpeg;
      }
    } catch {
      /* try the next one */
    }
  }
  cachedFfmpeg = null;
  return cachedFfmpeg;
}

/** Why resolveFfmpeg() found nothing, and what to do about it. */
export function ffmpegMissingReason() {
  return staticWithoutBinary
    ? "ffmpeg-static is installed without its binary — run: npm approve-scripts ffmpeg-static && npm rebuild ffmpeg-static"
    : "ffmpeg wasn't found — see Install in the README";
}

/**
 * Map 1–100 quality onto H.264's CRF: 100 -> 18 (visually lossless),
 * 80 -> 22, 50 -> 29, 1 -> 40. Lower CRF means higher quality.
 */
export function qualityToCrf(quality) {
  const q = Math.min(100, Math.max(1, Number(quality) || 0));
  return Math.round(40 - (q / 100) * 22);
}

/**
 * Width, height, duration and rotation from ffmpeg's own banner, so no
 * separate ffprobe is needed (ffmpeg-static ships without one).
 */
export function probeVideo(ffmpeg, filePath) {
  const res = spawnSync(ffmpeg, ["-hide_banner", "-i", filePath], { encoding: "utf8" });
  const err = `${res.stderr || ""}`;

  const dim = err.match(/Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/);
  const dur = err.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const rot = err.match(/rotate\s*:\s*(-?\d+)/) || err.match(/(-?\d+(?:\.\d+)?)\s*degrees/);

  let width = dim ? Number(dim[1]) : null;
  let height = dim ? Number(dim[2]) : null;
  // Phones store rotation as metadata and ffmpeg applies it when encoding,
  // so swap to reason about the displayed size.
  const rotation = rot ? ((Math.round(Number(rot[1])) % 360) + 360) % 360 : 0;
  if (width && (rotation === 90 || rotation === 270)) [width, height] = [height, width];

  const duration = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : null;
  return { width, height, duration, rotation, hasAudio: /Audio:/.test(err) };
}

const abortError = () => Object.assign(new Error("Stopped"), { name: "AbortError" });

/** Encode one rendition; progress comes from ffmpeg's `-progress` stream. */
export function transcodeRendition(ffmpeg, input, output, { width, crf, preset, duration, onProgress, signal }) {
  const args = [
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", input,
    "-vf", `scale=${width}:-2`, // keep the aspect ratio, even height
    "-c:v", "libx264",
    "-crf", String(crf),
    "-preset", preset,
    "-pix_fmt", "yuv420p", // plays on every device
    "-profile:v", "high",
    "-movflags", "+faststart", // index first: playback starts before the download ends
    "-c:a", "aac", "-b:a", "128k",
    "-map_metadata", "-1", // drop metadata, location included
    "-progress", "pipe:1", "-nostats",
    output,
  ];

  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const child = spawn(ffmpeg, args);
    let stderr = "";
    const stop = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", stop, { once: true });

    child.stderr.on("data", (d) => { stderr += d; });
    child.stdout.on("data", (d) => {
      // out_time_ms is in microseconds, despite its name.
      const m = String(d).match(/out_time_ms=(\d+)/);
      if (m && duration && onProgress) onProgress(Math.min(100, (Number(m[1]) / 1e6 / duration) * 100));
    });
    child.on("error", reject);
    child.on("close", (code) => {
      signal?.removeEventListener("abort", stop);
      if (signal?.aborted) {
        fs.rmSync(output, { force: true }); // a partial file is worse than none
        reject(abortError());
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
      }
    });
  });
}

/** A frame from the start of the video, saved in `format` (best effort). */
async function extractPoster(ffmpeg, file, outDir, parsed, { width, format, quality }) {
  const tmp = path.join(os.tmpdir(), `webready-poster-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  const res = spawnSync(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", file.full, "-frames:v", "1", tmp], {
    encoding: "utf8",
  });
  if (res.status !== 0 || !fs.existsSync(tmp)) throw new Error(res.stderr || "poster extraction failed");

  try {
    const rel = toPosix(path.posix.join(parsed.dir, `${parsed.name}-poster.${format}`));
    const pipeline = sharp(tmp).resize({ width, withoutEnlargement: true });
    await (format === "webp" ? pipeline.webp({ quality }) : pipeline.avif({ quality, effort: 4 })).toFile(
      path.join(outDir, rel),
    );
    return rel;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Encode one video as MP4 (H.264/AAC) renditions at `settings.widths`, plus
 * a poster in the most widely supported of the image formats.
 *
 * @returns manifest entry { type, source, width, height, duration, poster, renditions }
 */
export async function optimizeVideo(ffmpeg, file, outDir, settings, { onProgress, signal } = {}) {
  const info = probeVideo(ffmpeg, file.full);
  if (!info.width || !info.height) throw new Error("Can't read this video's dimensions");

  const widths = pickWidths(info.width, settings.widths, { even: true });
  const crf = qualityToCrf(settings.videos.quality);
  const parsed = path.posix.parse(file.rel);
  fs.mkdirSync(path.join(outDir, parsed.dir), { recursive: true });

  const renditions = [];
  for (const width of widths) {
    const rel = toPosix(path.posix.join(parsed.dir, `${parsed.name}-${width}.mp4`));
    await transcodeRendition(ffmpeg, file.full, path.join(outDir, rel), {
      width,
      crf,
      preset: settings.videos.preset,
      duration: info.duration,
      onProgress: (percent) => onProgress?.({ width, percent }),
      signal,
    });
    const height = Math.round(((width / info.width) * info.height) / 2) * 2;
    renditions.push({ format: "mp4", width, height, bytes: fs.statSync(path.join(outDir, rel)).size, file: rel });
  }

  let poster = null;
  if (settings.videos.poster) {
    const format = settings.images.formats.at(-1);
    try {
      poster = await extractPoster(ffmpeg, file, outDir, parsed, {
        width: widths.at(-1),
        format,
        quality: settings.images.quality[format],
      });
    } catch {
      /* a poster is a nice-to-have: never fail the video for it */
    }
  }

  return {
    type: "video",
    source: file.rel,
    width: info.width,
    height: info.height,
    duration: info.duration,
    poster,
    renditions,
  };
}

/**
 * Encode many videos, one at a time (ffmpeg already uses every core).
 * Failures are collected, not thrown.
 */
export async function optimizeVideos(ffmpeg, files, outDir, settings, { onFile, onProgress, signal } = {}) {
  const entries = [];
  const errors = [];
  for (const file of files) {
    if (signal?.aborted) break;
    try {
      const entry = await optimizeVideo(ffmpeg, file, outDir, settings, {
        signal,
        onProgress: (p) => onProgress?.({ file, ...p }),
      });
      entries.push(entry);
      onFile?.({ file, entry });
    } catch (error) {
      if (error.name === "AbortError") break;
      errors.push({ source: file.rel, message: String(error.message || error).slice(0, 400) });
      onFile?.({ file, error });
    }
  }
  return { entries, errors };
}
