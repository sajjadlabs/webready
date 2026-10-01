// webready — the Node API. Everything the command does, in code.

export { webready, planRun, executePlan, describePlan, deliveredBytes, CollisionError } from "./lib/run.js";
export { watch } from "./lib/watch.js";
export { resolveOptions, loadConfigFile, mergeOptions, ConfigError, DEFAULTS, IMAGE_FORMATS } from "./config.js";
export { scanMedia, findCollisions, IMAGE_EXTS, VIDEO_EXTS } from "./lib/scan.js";
export { optimizeImage, optimizeImages } from "./lib/images.js";
export { optimizeVideo, optimizeVideos, resolveFfmpeg, ffmpegMissingReason, probeVideo, qualityToCrf } from "./lib/videos.js";
export { renderMarkup, pictureMarkup, videoMarkup } from "./lib/markup.js";
export { readManifest, MANIFEST_FILE, MARKUP_FILE, VERSION } from "./lib/manifest.js";
export { formatBytes, pickWidths } from "./core.js";
