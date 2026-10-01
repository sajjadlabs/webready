// Planning and running a conversion: what to encode and why, then doing it.

import fs from "node:fs";
import path from "node:path";
import { resolveOptions } from "../config.js";
import { runPool } from "../core.js";
import { scanMedia, findCollisions } from "./scan.js";
import {
  readManifest, writeManifest, emptyManifest, fingerprint, settingsKey,
  outputsExist, entryFiles, removeFiles, MANIFEST_FILE, MARKUP_FILE,
} from "./manifest.js";
import { optimizeImage } from "./images.js";
import { optimizeVideo, resolveFfmpeg, ffmpegMissingReason } from "./videos.js";
import { renderMarkup } from "./markup.js";

/** Two or more sources would write the same output files. The CLI exits with code 2. */
export class CollisionError extends Error {
  constructor(groups) {
    super(
      "These files would write the same outputs — rename one in each group:\n" +
        groups.map((group) => `  ${group.join("  ·  ")}`).join("\n"),
    );
    this.name = "CollisionError";
    this.exitCode = 2;
    this.groups = groups;
  }
}

const group = (kind) => `${kind}s`;

/**
 * What the widest screens download: the largest rendition in the preferred
 * format. Each browser fetches one rendition, so this - not the total of
 * all of them - is the honest "after" size.
 */
export function deliveredBytes(entry) {
  const preferred = entry.formats?.[0];
  const candidates = preferred ? entry.renditions.filter((r) => r.format === preferred) : entry.renditions;
  return candidates.reduce((best, r) => (r.width > best.width ? r : best)).bytes;
}

/**
 * Work out what a run would do, without writing anything.
 *
 * Each source is either a task - with the reason: "new", "changed",
 * "settings", "missing" (outputs deleted) or "forced" - or unchanged.
 * Sources in the previous manifest that no longer exist are stale.
 */
export async function planRun(settings, { force = false, clean = false } = {}) {
  const scan = scanMedia(settings.input, { only: settings.only, exclude: [settings.out] });
  const collisions = findCollisions(scan);
  if (collisions.length) throw new CollisionError(collisions);

  const previous = readManifest(settings.out);
  const keys = { image: settingsKey("image", settings), video: settingsKey("video", settings) };
  const tasks = [];
  const unchanged = [];

  for (const [kind, files] of [["image", scan.images], ["video", scan.videos]]) {
    const before = previous?.[group(kind)] ?? {};
    for (const file of files) {
      const prev = before[file.rel] ?? null;
      const print = await fingerprint(file, prev);
      let reason = null;
      if (force) reason = "forced";
      else if (!prev) reason = "new";
      else if (prev.fingerprint !== print) reason = "changed";
      else if (prev.settings !== keys[kind]) reason = "settings";
      else if (!outputsExist(settings.out, prev)) reason = "missing";

      const item = { kind, file, fingerprint: print, previous: prev };
      if (reason) tasks.push({ ...item, reason });
      else unchanged.push(item);
    }
  }

  // Sources that are gone. With `only`, the other kind is left alone.
  const stale = [];
  for (const kind of ["image", "video"]) {
    if (settings.only && settings.only !== group(kind)) continue;
    const present = new Set(scan[group(kind)].map((f) => f.rel));
    for (const [source, entry] of Object.entries(previous?.[group(kind)] ?? {})) {
      if (!present.has(source)) stale.push({ kind, source, files: entryFiles(entry) });
    }
  }

  return { settings, scan, previous, keys, tasks, unchanged, stale, clean };
}

/** A plan as a report, for --dry-run. */
export function describePlan(plan) {
  return {
    dryRun: true,
    ok: true,
    input: plan.settings.input,
    out: plan.settings.out,
    encode: plan.tasks.map((t) => ({ source: t.file.rel, kind: t.kind, reason: t.reason })),
    unchanged: plan.unchanged.map((u) => u.file.rel),
    stale: plan.stale.map((s) => s.source),
    remove: plan.clean ? plan.stale.flatMap((s) => s.files) : [],
    skipped: plan.scan.skipped,
  };
}

/**
 * Carry out a plan.
 *
 * @param {object} plan  from planRun()
 * @param {{clean?: boolean, signal?: AbortSignal,
 *   onStart?: (task) => void,
 *   onTask?: ({task, entry?, error?, before?, after?}) => void,
 *   onProgress?: ({task, width, percent}) => void}} [options]
 *   `signal` stops the run: files in progress finish (videos stop at once),
 *   and the manifest is written for everything done.
 */
export async function executePlan(plan, { clean = plan.clean, signal, onStart, onTask, onProgress } = {}) {
  const started = performance.now();
  const { settings } = plan;
  const manifest = emptyManifest(settings.publicPath);
  const done = new Set();

  for (const { kind, file, previous } of plan.unchanged) manifest[group(kind)][file.rel] = previous;
  if (plan.previous && settings.only) {
    const other = settings.only === "images" ? "videos" : "images";
    manifest[other] = { ...plan.previous[other] };
  }

  const report = {
    ok: true,
    input: settings.input,
    out: settings.out,
    manifest: path.join(settings.out, MANIFEST_FILE),
    markup: settings.markup === "none" ? null : path.join(settings.out, MARKUP_FILE),
    images: { converted: 0, unchanged: plan.unchanged.filter((u) => u.kind === "image").length, failed: 0 },
    videos: { converted: 0, unchanged: plan.unchanged.filter((u) => u.kind === "video").length, failed: 0 },
    skipped: [...plan.scan.skipped],
    removed: [],
    // before: the sources; after: what the widest screens download;
    // written: every rendition on disk.
    bytes: { before: 0, after: 0, written: 0 },
    errors: [],
    durationMs: 0,
  };

  fs.mkdirSync(settings.out, { recursive: true });

  const record = (task, entry) => {
    Object.assign(entry, {
      sourceBytes: task.file.size,
      sourceMtimeMs: task.file.mtimeMs,
      fingerprint: task.fingerprint,
      settings: plan.keys[task.kind],
    });
    // Files the previous version owned that this one doesn't: a width or
    // format that's no longer produced.
    if (task.previous) {
      const keep = new Set(entryFiles(entry));
      report.removed.push(...removeFiles(settings.out, entryFiles(task.previous).filter((f) => !keep.has(f))));
    }
    manifest[group(task.kind)][task.file.rel] = entry;
    done.add(task);

    const after = deliveredBytes(entry);
    report.bytes.before += task.file.size;
    report.bytes.after += after;
    report.bytes.written += entry.renditions.reduce((sum, r) => sum + r.bytes, 0);
    report[group(task.kind)].converted++;
    onTask?.({ task, entry, before: task.file.size, after });
  };

  const fail = (task, error) => {
    // The previous outputs still work. Its old fingerprint stays in the
    // manifest, so the next run tries again.
    if (task.previous) manifest[group(task.kind)][task.file.rel] = task.previous;
    done.add(task);
    report[group(task.kind)].failed++;
    report.errors.push({ source: task.file.rel, kind: task.kind, message: String(error.message || error).slice(0, 400) });
    onTask?.({ task, error });
  };

  const imageTasks = plan.tasks.filter((t) => t.kind === "image");
  const videoTasks = plan.tasks.filter((t) => t.kind === "video");

  await runPool(imageTasks, settings.concurrency, async (task) => {
    if (signal?.aborted) return;
    onStart?.(task);
    try {
      record(task, await optimizeImage(task.file, settings.out, settings));
    } catch (error) {
      fail(task, error);
    }
  });

  if (videoTasks.length && !signal?.aborted) {
    const ffmpeg = await resolveFfmpeg();
    if (!ffmpeg) {
      for (const task of videoTasks) {
        report.skipped.push({ source: task.file.rel, reason: ffmpegMissingReason() });
      }
    } else {
      for (const task of videoTasks) {
        if (signal?.aborted) break;
        onStart?.(task);
        try {
          record(task, await optimizeVideo(ffmpeg, task.file, settings.out, settings, {
            signal,
            onProgress: (p) => onProgress?.({ task, ...p }),
          }));
        } catch (error) {
          if (error.name === "AbortError") break;
          fail(task, error);
        }
      }
    }
  }

  // Not done - stopped, or skipped for want of ffmpeg: keep what was there.
  for (const task of plan.tasks) {
    if (!done.has(task) && task.previous) manifest[group(task.kind)][task.file.rel] = task.previous;
  }
  if (signal?.aborted) report.aborted = true;

  for (const item of plan.stale) {
    if (clean) report.removed.push(...removeFiles(settings.out, item.files));
    else manifest[group(item.kind)][item.source] = plan.previous[group(item.kind)][item.source];
  }

  writeManifest(settings.out, manifest);
  const markupPath = path.join(settings.out, MARKUP_FILE);
  if (settings.markup === "none") fs.rmSync(markupPath, { force: true });
  else fs.writeFileSync(markupPath, renderMarkup(manifest, { style: settings.markup, publicPath: settings.publicPath }));

  report.ok = report.errors.length === 0 && !report.aborted;
  report.durationMs = Math.round(performance.now() - started);
  return report;
}

/**
 * Convert a folder: everything the command does, in code.
 *
 * @param {string} [input]  the input folder (or options.input)
 * @param {object} [options]  the config file's keys, plus:
 *   `force`, `clean`, `dryRun`, `signal`, `onStart`, `onTask`, `onProgress`, `cwd`
 * @returns {Promise<object>} the report --json prints
 */
export async function webready(input, options = {}) {
  const { force, clean, dryRun, signal, onStart, onTask, onProgress, cwd, ...config } = options;
  const settings = resolveOptions(input, config, { cwd });
  const plan = await planRun(settings, { force, clean });
  if (dryRun) return describePlan(plan);
  return executePlan(plan, { clean, signal, onStart, onTask, onProgress });
}
