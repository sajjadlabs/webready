// Settings: the defaults, the config file, command-line flags, and turning
// all three into one validated settings object.
//
// Precedence: flags > config file > defaults. Paths in the config file are
// relative to the file's own folder; paths in flags to the current directory.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CONFIG_FILE = "webready.config.json";
export const IMAGE_FORMATS = Object.freeze(["avif", "webp"]);
export const MARKUP_STYLES = Object.freeze(["srcset", "media", "none"]);
export const X264_PRESETS = Object.freeze([
  "ultrafast", "superfast", "veryfast", "faster", "fast",
  "medium", "slow", "slower", "veryslow",
]);
// AVIF 60 and WebP 80 look about the same.
export const DEFAULT_QUALITY = Object.freeze({ avif: 60, webp: 80 });

export const DEFAULTS = Object.freeze({
  widths: [640, 1024, 1440, 1920],
  markup: "srcset",
  images: { format: ["avif"], quality: { ...DEFAULT_QUALITY }, effort: 4, lossless: false },
  videos: { quality: 80, preset: "medium", poster: true },
});

const CONFIG_KEYS = new Set([
  "input", "out", "publicPath", "widths", "only", "markup", "concurrency", "images", "videos",
]);
const IMAGE_KEYS = new Set(["format", "quality", "effort", "lossless"]);
const VIDEO_KEYS = new Set(["quality", "preset", "poster"]);

/** A problem with the user's input or settings. The CLI exits with code 2. */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
    this.exitCode = 2;
  }
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Merge settings objects: nested `images`/`videos` merge, everything else replaces. */
export function mergeOptions(...layers) {
  const out = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [key, value] of Object.entries(layer)) {
      if (value === undefined) continue;
      out[key] =
        (key === "images" || key === "videos") && isPlainObject(value)
          ? { ...(out[key] || {}), ...value }
          : value;
    }
  }
  return out;
}

/**
 * Read webready.config.json (or the given file). Missing default file -> {}.
 * Relative `input`/`out` are resolved against the config file's folder.
 */
export function loadConfigFile({ cwd = process.cwd(), file } = {}) {
  const fullPath = path.resolve(cwd, file ?? CONFIG_FILE);
  if (!fs.existsSync(fullPath)) {
    if (file) throw new ConfigError(`Config file not found: ${file}`);
    return { config: {}, path: null };
  }

  const shown = path.relative(cwd, fullPath) || fullPath;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(fullPath, "utf8"));
  } catch (error) {
    throw new ConfigError(`${shown} isn't valid JSON: ${error.message}`);
  }
  if (!isPlainObject(raw)) throw new ConfigError(`${shown} must contain a JSON object`);

  const { $schema, ...config } = raw;
  const problems = [];
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) problems.push(`unknown key "${key}"`);
  }
  for (const [group, keys] of [["images", IMAGE_KEYS], ["videos", VIDEO_KEYS]]) {
    if (config[group] === undefined) continue;
    if (!isPlainObject(config[group])) {
      problems.push(`"${group}" must be an object`);
      continue;
    }
    for (const key of Object.keys(config[group])) {
      if (!keys.has(key)) problems.push(`unknown key "${group}.${key}"`);
    }
  }
  if (problems.length) throw new ConfigError(`${shown}: ${problems.join("; ")}`);

  const dir = path.dirname(fullPath);
  for (const key of ["input", "out"]) {
    if (typeof config[key] === "string") config[key] = path.resolve(dir, config[key]);
  }
  return { config, path: fullPath };
}

const toInteger = (value, flag, problems) => {
  const n = Number(value);
  if (!Number.isInteger(n)) {
    problems.push(`${flag} must be a whole number (got "${value}")`);
    return undefined;
  }
  return n;
};

const splitList = (value) =>
  String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Turn parsed command-line flags into options. Paths are resolved against
 * `cwd`. Throws ConfigError for values that can't be parsed at all.
 */
export function optionsFromFlags(values, { cwd = process.cwd() } = {}) {
  const problems = [];
  const options = {};
  const images = {};
  const videos = {};

  if (values.out !== undefined) options.out = path.resolve(cwd, values.out);
  if (values["public-path"] !== undefined) options.publicPath = values["public-path"];
  if (values.widths !== undefined) {
    options.widths = splitList(values.widths).map((w) => toInteger(w, "--widths", problems));
  }
  if (values.only !== undefined) options.only = values.only;
  if (values.markup !== undefined) options.markup = values.markup;
  if (values.concurrency !== undefined) {
    options.concurrency = toInteger(values.concurrency, "--concurrency", problems);
  }

  if (values.format !== undefined) images.format = splitList(values.format);
  if (values.quality !== undefined) images.quality = toInteger(values.quality, "--quality", problems);
  if (values.effort !== undefined) images.effort = toInteger(values.effort, "--effort", problems);
  if (values.lossless) images.lossless = true;

  if (values["video-quality"] !== undefined) {
    videos.quality = toInteger(values["video-quality"], "--video-quality", problems);
  }
  if (values.preset !== undefined) videos.preset = values.preset;
  if (values["no-poster"]) videos.poster = false;

  if (problems.length) throw new ConfigError(problems.join("\n"));
  if (Object.keys(images).length) options.images = images;
  if (Object.keys(videos).length) options.videos = videos;
  return options;
}

/** "/media/" -> "/media"; null/"" -> null (paths relative to the output folder). */
function normalizePublicPath(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim().replace(/\/+$/, "");
  return s === "" ? "" : s;
}

const inRange = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;

/**
 * Resolve options (config keys) into complete, validated settings.
 *
 * @param {string|undefined} input  the input folder; falls back to options.input
 * @param {object} options          config-file keys
 * @returns {Readonly<object>} settings
 * @throws {ConfigError} listing every problem found
 */
export function resolveOptions(input, options = {}, { cwd = process.cwd() } = {}) {
  const o = mergeOptions(DEFAULTS, options);
  const problems = [];

  const inputValue = input ?? options.input;
  if (!inputValue) throw new ConfigError("No input folder: pass one (webready ./media) or set \"input\" in webready.config.json");
  const inputDir = path.resolve(cwd, inputValue);
  if (!fs.existsSync(inputDir) || !fs.statSync(inputDir).isDirectory()) {
    throw new ConfigError(`Input folder not found: ${path.relative(cwd, inputDir) || inputDir}`);
  }

  const out = o.out
    ? path.resolve(cwd, o.out)
    : path.join(path.dirname(inputDir), `${path.basename(inputDir)}-web`);
  if (out === inputDir) problems.push("The output folder can't be the input folder");

  const widths = Array.isArray(o.widths) ? o.widths : [o.widths];
  if (!widths.length || !widths.every((w) => inRange(w, 16, 16384))) {
    problems.push("widths must be whole numbers of pixels, between 16 and 16384");
  }

  if (o.only !== undefined && o.only !== "images" && o.only !== "videos") {
    problems.push(`only must be "images" or "videos" (got "${o.only}")`);
  }
  if (!MARKUP_STYLES.includes(o.markup)) {
    problems.push(`markup must be ${MARKUP_STYLES.map((s) => `"${s}"`).join(", ")} (got "${o.markup}")`);
  }

  let concurrency = o.concurrency;
  if (concurrency === undefined) {
    concurrency = os.availableParallelism?.() ?? os.cpus().length ?? 4;
  } else if (!inRange(concurrency, 1, 256)) {
    problems.push("concurrency must be a whole number from 1");
  }

  // Images
  const rawFormats = Array.isArray(o.images.format) ? o.images.format : splitList(o.images.format);
  const formats = [...new Set(rawFormats.map((f) => String(f).toLowerCase()))];
  const badFormats = formats.filter((f) => !IMAGE_FORMATS.includes(f));
  if (!formats.length || badFormats.length) {
    problems.push(`images.format must be "avif", "webp", or both (got "${rawFormats.join(",")}")`);
  }
  const quality = {};
  for (const format of IMAGE_FORMATS) {
    const q = typeof o.images.quality === "number"
      ? o.images.quality
      : o.images.quality?.[format] ?? DEFAULT_QUALITY[format];
    if (!inRange(q, 1, 100)) problems.push(`images.quality for ${format} must be 1–100 (got ${q})`);
    quality[format] = q;
  }
  if (!inRange(o.images.effort, 0, 9)) problems.push("images.effort must be 0–9");
  if (typeof o.images.lossless !== "boolean") problems.push("images.lossless must be true or false");

  // Videos
  if (!inRange(o.videos.quality, 1, 100)) problems.push("videos.quality must be 1–100");
  if (!X264_PRESETS.includes(o.videos.preset)) {
    problems.push(`videos.preset must be one of: ${X264_PRESETS.join(", ")}`);
  }
  if (typeof o.videos.poster !== "boolean") problems.push("videos.poster must be true or false");

  if (problems.length) throw new ConfigError(problems.join("\n"));

  return Object.freeze({
    input: inputDir,
    out,
    publicPath: normalizePublicPath(o.publicPath),
    widths: [...new Set(widths)].sort((a, b) => a - b),
    only: o.only,
    markup: o.markup,
    concurrency,
    images: Object.freeze({
      formats,
      quality: Object.freeze(Object.fromEntries(formats.map((f) => [f, quality[f]]))),
      effort: o.images.effort,
      lossless: o.images.lossless,
    }),
    videos: Object.freeze({ ...o.videos }),
  });
}
