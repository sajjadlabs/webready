/**
 * End-to-end tests of the pipeline, with real sharp and ffmpeg.
 * Fixtures are generated into a temporary folder, so nothing is committed.
 *
 * Run with: node test/pipeline.test.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import sharp from "sharp";
import { webready, watch, resolveFfmpeg, readManifest, CollisionError } from "../src/index.js";

let failures = 0;
const must = (cond, msg) => {
  if (cond) console.log(`  OK   ${msg}`);
  else { console.error(`  FAIL ${msg}`); failures++; }
};
const section = (name) => console.log(`\n${name}:`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── fixtures ─────────────────────────────────────────────────────────────
const root = fs.mkdtempSync(path.join(os.tmpdir(), "webready-test-"));
const media = path.join(root, "media");
const out = path.join(root, "public", "media");
fs.mkdirSync(path.join(media, "team"), { recursive: true });

const noise = (width, height, seed = 1) => {
  const data = Buffer.alloc(width * height * 3);
  let x = seed;
  for (let i = 0; i < data.length; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    data[i] = (x >> 16) & 0xff;
  }
  return sharp(data, { raw: { width, height, channels: 3 } }).blur(1.5);
};
await noise(1600, 1067).png().toFile(path.join(media, "hero.png"));
await noise(500, 333, 2).jpeg().toFile(path.join(media, "small.jpg"));
// Stored landscape, tagged "rotate 90°": displayed as a 800x1200 portrait.
await noise(1200, 800, 3).jpeg().withMetadata({ orientation: 6 }).toFile(path.join(media, "team", "sara.jpg"));
fs.writeFileSync(path.join(media, "broken.jpg"), Buffer.from("this is not an image"));
fs.writeFileSync(path.join(media, "photo.heic"), Buffer.from("pretend heic"));
fs.writeFileSync(path.join(media, "logo.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
fs.writeFileSync(path.join(media, "notes.txt"), "not media");

const ffmpeg = await resolveFfmpeg();
if (ffmpeg) {
  spawnSync(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=24:duration=1",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
    path.join(media, "intro.mp4"),
  ]);
}

const exists = (rel) => fs.existsSync(path.join(out, rel));
const mtime = (rel) => fs.statSync(path.join(out, rel)).mtimeMs;
const base = {
  out,
  publicPath: "/media/",
  widths: [640, 1024, 1440, 1920],
  images: { format: ["avif", "webp"], effort: 2 },
  videos: { preset: "ultrafast" },
};

// ── first run ────────────────────────────────────────────────────────────
section("first run");
let report = await webready(media, base);
must(report.images.converted === 3 && report.images.failed === 1, `3 images converted, 1 failed (${JSON.stringify(report.images)})`);
must(report.errors[0]?.source === "broken.jpg" && !report.ok, "the broken file is reported, and the run is not ok");
must(["640", "1024", "1440", "1600"].every((w) => exists(`hero-${w}.avif`) && exists(`hero-${w}.webp`)), "hero: 640, 1024, 1440 and 1600 (capped at its width), in AVIF and WebP");
must(!exists("hero-1920.avif"), "never upscaled");
must(exists("small-500.avif") && !exists("small-640.avif"), "a 500px image gets one 500px rendition");
const sara = readManifest(out).images["team/sara.jpg"];
must(sara.width === 800 && sara.height === 1200, `EXIF rotation applied: 800x1200 (${sara.width}x${sara.height})`);
must(exists("team/sara-640.avif") && exists("team/sara-800.webp"), "folder structure mirrored");
must(report.skipped.some((s) => s.source === "photo.heic" && /convert it to JPEG/.test(s.reason)), "HEIC skipped, with what to do");
must(report.skipped.some((s) => s.source === "logo.svg") && !report.skipped.some((s) => s.source === "notes.txt"), "SVG skipped with a reason; other files ignored quietly");

if (ffmpeg) {
  must(report.videos.converted === 1, "the video converted");
  must(exists("intro-640.mp4") && exists("intro-1024.mp4") && exists("intro-1280.mp4") && !exists("intro-1440.mp4"), "video: 640, 1024 and 1280 (capped)");
  must(exists("intro-poster.webp") && !exists("intro-poster.avif"), "the poster uses the most widely supported format: WebP");
} else {
  console.log("  (ffmpeg not found — video checks skipped)");
}

const manifest = readManifest(out);
must(manifest.publicPath === "/media", "the manifest records the public path, without a trailing slash");

// "after" is what the widest screens download: the largest AVIF per image
// (the preferred format) and the largest MP4 per video - not every file.
const largest = (entry, format) =>
  Math.max(...entry.renditions.filter((r) => !format || r.format === format).map((r) => r.width));
const expectedAfter =
  Object.values(manifest.images).reduce((sum, e) =>
    sum + e.renditions.find((r) => r.format === "avif" && r.width === largest(e, "avif")).bytes, 0) +
  Object.values(manifest.videos).reduce((sum, e) =>
    sum + e.renditions.find((r) => r.width === largest(e)).bytes, 0);
must(report.bytes.after === expectedAfter, `sizes: "after" is what the widest screens download (${report.bytes.after} bytes)`);
must(report.bytes.written > report.bytes.after, "...and the total on disk is reported separately");
const html = fs.readFileSync(path.join(out, "webready.html"), "utf8");
must(html.includes('srcset="/media/hero-640.avif 640w, /media/hero-1024.avif 1024w'), "markup: AVIF srcset with site URLs");
must(html.includes('<img src="/media/hero-1600.webp" alt="" width="1600" height="1067" loading="lazy" decoding="async">'), "markup: the <img> fallback is the largest WebP, with its size");
if (ffmpeg) {
  must(html.includes('<source src="/media/intro-1280.mp4" media="(min-width: 1025px)" type="video/mp4">'), "markup: video sources by min-width, widest first");
  must(html.includes('poster="/media/intro-poster.webp"'), "markup: the poster");
}

// ── incremental runs ─────────────────────────────────────────────────────
section("incremental runs");
const heroTime = mtime("hero-640.avif");
report = await webready(media, base);
must(report.images.converted === 0 && report.images.unchanged === 3, "nothing changed: nothing re-encoded");
if (ffmpeg) must(report.videos.unchanged === 1, "the video is unchanged too");
must(mtime("hero-640.avif") === heroTime, "outputs untouched");
must(report.images.failed === 1, "the broken file is retried, and fails again");

await noise(500, 333, 9).jpeg().toFile(path.join(media, "small.jpg"));
report = await webready(media, base);
must(report.images.converted === 1, "one source edited: only it is re-encoded");

report = await webready(media, { ...base, images: { ...base.images, quality: { avif: 50 } } });
must(report.images.converted === 3, "AVIF quality changed: the images re-encode");
if (ffmpeg) must(report.videos.converted === 0, "...but not the video, whose WebP poster didn't change");

report = await webready(media, { ...base, widths: [640, 1024] });
must(!exists("hero-1440.avif") && !exists("hero-1600.webp") && exists("hero-1024.avif"), "widths dropped: those renditions are removed");
must(report.removed.includes("hero-1440.avif"), "...and listed in the report");

fs.renameSync(path.join(media, "small.jpg"), path.join(root, "small.jpg"));
report = await webready(media, { ...base, widths: [640, 1024] });
must(exists("small-500.avif") && readManifest(out).images["small.jpg"], "a source deleted: its outputs stay without --clean");
report = await webready(media, { ...base, widths: [640, 1024], clean: true });
must(!exists("small-500.avif") && !readManifest(out).images["small.jpg"], "--clean removes them");
fs.renameSync(path.join(root, "small.jpg"), path.join(media, "small.jpg"));

section("dry run, force, only");
const before = mtime("hero-640.avif");
report = await webready(media, { ...base, widths: [640, 1024], dryRun: true });
must(report.dryRun && report.encode.length === 2 && report.encode.some((e) => e.source === "small.jpg" && e.reason === "new"), `--dry-run lists what would be encoded, and why (${report.encode.map((e) => `${e.source}:${e.reason}`).join(", ")})`);
must(!exists("small-500.avif") && mtime("hero-640.avif") === before, "--dry-run writes nothing");

report = await webready(media, { ...base, widths: [640, 1024], force: true, only: "images" });
must(report.images.converted === 3 && report.images.failed === 1 && report.images.unchanged === 0, "--force re-encodes everything (the broken file still fails)");
if (ffmpeg) must(readManifest(out).videos["intro.mp4"], "--only images leaves the videos in the manifest alone");

// ── markup styles ────────────────────────────────────────────────────────
section("markup styles");
await webready(media, { ...base, widths: [640, 1024], markup: "media" });
const mediaHtml = fs.readFileSync(path.join(out, "webready.html"), "utf8");
must(mediaHtml.includes('<source type="image/avif" media="(max-width: 640px)" srcset="/media/hero-640.avif">\n  <source type="image/webp" media="(max-width: 640px)" srcset="/media/hero-640.webp">'), "media style: per width, AVIF before WebP");
must(mediaHtml.includes('<source type="image/avif" srcset="/media/hero-1024.avif">'), "media style: the widest source has no media query");
await webready(media, { ...base, widths: [640, 1024], markup: "none" });
must(!exists("webready.html") && exists("webready.json"), "markup none: no webready.html, but the manifest stays");

// ── collisions ───────────────────────────────────────────────────────────
section("collisions");
const twins = path.join(root, "twins");
fs.mkdirSync(twins);
await noise(100, 100).jpeg().toFile(path.join(twins, "hero.jpg"));
await noise(100, 100).png().toFile(path.join(twins, "Hero.png"));
let error = null;
try { await webready(twins); } catch (e) { error = e; }
must(error instanceof CollisionError && error.exitCode === 2, "same-name sources stop the run (exit code 2)");
must(/hero\.jpg/.test(error?.message) && /Hero\.png/.test(error?.message), "...and the message names them, regardless of case");

// ── watch mode ───────────────────────────────────────────────────────────
section("watch mode");
const watched = path.join(root, "watched");
fs.mkdirSync(watched);
await noise(300, 200).jpeg().toFile(path.join(watched, "one.jpg"));
const runs = [];
const watcher = watch(watched, { widths: [640], delay: 150 }, { onRun: (r) => runs.push(r) });
await watcher.ready;
must(runs.length === 1 && runs[0].images.converted === 1, "the first run converts what's there");
await noise(300, 200, 5).jpeg().toFile(path.join(watched, "two.jpg"));
for (let i = 0; i < 50 && runs.length < 2; i++) await sleep(100);
must(runs[1]?.images.converted === 1, "a new file is converted within moments");
fs.rmSync(path.join(watched, "one.jpg"));
for (let i = 0; i < 50 && runs.length < 3; i++) await sleep(100);
must(runs[2]?.removed.includes("one-300.avif"), "a deleted file's outputs are removed");
watcher.close();

// ── stopping a run ───────────────────────────────────────────────────────
if (ffmpeg) {
  section("stopping");
  const controller = new AbortController();
  report = await webready(media, {
    ...base,
    widths: [640, 1024],
    force: true,
    signal: controller.signal,
    onProgress: () => controller.abort(),
  });
  must(report.aborted && !report.ok, "a stopped run says so");
  const mp4s = fs.readdirSync(out).filter((f) => f.endsWith(".mp4"));
  must(mp4s.every((f) => fs.statSync(path.join(out, f)).size > 1000), "no half-written video is left behind");
  must(readManifest(out).images["hero.png"], "the manifest still lists what was finished");
}

fs.rmSync(root, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : "\nAll good ✅");
process.exit(failures ? 1 : 0);
