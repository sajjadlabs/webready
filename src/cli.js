#!/usr/bin/env node
// The `webready` command.

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import * as p from "@clack/prompts";
import { color } from "console-log-colors";
import {
  CONFIG_FILE, ConfigError, DEFAULT_QUALITY, X264_PRESETS,
  loadConfigFile, mergeOptions, optionsFromFlags, resolveOptions,
} from "./config.js";
import { planRun, executePlan, describePlan } from "./lib/run.js";
import { watch } from "./lib/watch.js";
import { scanMedia } from "./lib/scan.js";
import { VERSION } from "./lib/manifest.js";
import { formatBytes } from "./core.js";

const OPTIONS = {
  out: { type: "string", short: "o" },
  "public-path": { type: "string" },
  format: { type: "string", short: "f" },
  widths: { type: "string", short: "w" },
  quality: { type: "string", short: "q" },
  effort: { type: "string" },
  lossless: { type: "boolean" },
  "video-quality": { type: "string" },
  preset: { type: "string" },
  "no-poster": { type: "boolean" },
  only: { type: "string" },
  markup: { type: "string" },
  concurrency: { type: "string" },
  watch: { type: "boolean" },
  "dry-run": { type: "boolean" },
  force: { type: "boolean" },
  clean: { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  json: { type: "boolean" },
  quiet: { type: "boolean" },
  config: { type: "string", short: "c" },
  version: { type: "boolean", short: "v" },
  help: { type: "boolean", short: "h" },
};

const HELP = `${color.bold("webready")} ${VERSION} — make your media web-ready

${color.bold("Usage")}
  webready                       guided mode (in a terminal)
  webready <folder> [options]    convert a folder
  webready init                  write ${CONFIG_FILE} from a few questions

${color.bold("Output")}
  -o, --out <dir>                output folder (default: <folder>-web)
      --public-path <url>        URL prefix for markup and manifest, e.g. /media
      --markup <style>           srcset (default), media or none

${color.bold("Images")}
  -f, --format <list>            avif (default), webp, or avif,webp
  -w, --widths <list>            rendition widths (default: 640,1024,1440,1920)
  -q, --quality <1-100>          image quality (default: AVIF 60, WebP 80)
      --effort <n>               encoder effort, AVIF 0–9 / WebP 0–6 (default: 4)
      --lossless                 lossless images

${color.bold("Videos")}
      --video-quality <1-100>    video quality (default: 80)
      --preset <name>            x264 preset (default: medium)
      --no-poster                don't make poster images

${color.bold("Running")}
      --only <images|videos>     process one kind only
      --concurrency <n>          images encoded in parallel (default: CPU cores)
      --watch                    keep running; update outputs as files change
      --dry-run                  show the plan, write nothing
      --force                    re-encode everything, even unchanged files
      --clean                    delete outputs whose sources are gone
  -y, --yes                      never prompt
      --json                     print a JSON report to stdout
      --quiet                    print errors only
  -c, --config <file>            config file (default: ${CONFIG_FILE})
  -v, --version                  print the version
  -h, --help                     print this help

Exit codes: 0 success · 1 some files failed · 2 usage or config error · 130 stopped
Docs: https://github.com/sajjadlabs/webready
`;

class Cancelled extends Error {}

const FORMAT_NAMES = { avif: "AVIF", webp: "WebP" };

const relTo = (cwd) => (target) => path.relative(cwd, target) || ".";
const firstLine = (message) => String(message).split("\n")[0].trim();
const sumBytes = (files) => files.reduce((total, f) => total + f.size, 0);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const saved = (before, after) => (before ? ` (${after <= before ? "−" : "+"}${Math.abs(Math.round((1 - after / before) * 100))}%)` : "");

function canPrompt(values) {
  return Boolean(
    process.stdin.isTTY && process.stdout.isTTY &&
    !values.yes && !values.json && !values.quiet && !process.env.CI,
  );
}

function printJson(report) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

/** Ctrl+C once: finish the files in progress, then stop. Twice: quit now. */
function onInterrupt(controller, say) {
  let presses = 0;
  const handler = () => {
    presses++;
    if (presses === 1) {
      controller.abort();
      say("Stopping after the files in progress… (Ctrl+C again to quit now)");
    } else {
      process.exit(130);
    }
  };
  process.on("SIGINT", handler);
  return () => process.off("SIGINT", handler);
}

// ─────────────────────────────────────────────────────────────────────────
// Plain output: `webready <folder>`, --watch, --dry-run, --json, --quiet
// ─────────────────────────────────────────────────────────────────────────

function createReporter(values, cwd) {
  const rel = relTo(cwd);
  const silent = values.json || values.quiet;
  const live = !silent && process.stdout.isTTY;
  let liveShown = false;
  const clearLive = () => {
    if (liveShown) {
      process.stdout.write("\r\x1b[2K");
      liveShown = false;
    }
  };
  const width = 28;
  const name = (s) => (s.length > width ? `…${s.slice(-(width - 1))}` : s.padEnd(width));

  return {
    header(settings) {
      if (silent) return;
      console.log(`${color.bold("webready")} ${color.dim(VERSION)}  ${rel(settings.input)} ${color.dim("→")} ${rel(settings.out)}`);
    },
    task({ task, error, before, after }) {
      clearLive();
      if (error) {
        console.error(`  ${color.red("✗")} ${name(task.file.rel)} ${color.red(firstLine(error.message))}`);
        return;
      }
      if (silent) return;
      console.log(`  ${color.green("✓")} ${name(task.file.rel)} ${formatBytes(before)} → ${formatBytes(after)}${color.dim(saved(before, after))}`);
    },
    progress({ task, width: w, percent }) {
      if (!live) return;
      process.stdout.write(`\r\x1b[2K  ${color.cyan("…")} ${task.file.rel} ${color.dim(`${w}px ${Math.round(percent)}%`)}`);
      liveShown = true;
    },
    say(message) {
      clearLive();
      if (!values.json) console.error(color.yellow(message));
    },
    error(error) {
      clearLive();
      console.error(`${color.red("Error:")} ${error.message}`);
    },
    summary(report) {
      clearLive();
      for (const s of report.skipped) {
        if (!values.json) console.error(`  ${color.yellow("–")} ${name(s.source)} ${color.dim(s.reason)}`);
      }
      if (silent) return;
      const converted = report.images.converted + report.videos.converted;
      const unchanged = report.images.unchanged + report.videos.unchanged;
      const failed = report.images.failed + report.videos.failed;
      const seconds = (report.durationMs / 1000).toFixed(1);
      if (!converted && !failed && !report.removed.length) {
        console.log(`${color.green("✓")} Everything is up to date ${color.dim(`(${plural(unchanged, "file")})`)}`);
      } else {
        const parts = [`${converted} converted`];
        if (unchanged) parts.push(`${unchanged} unchanged`);
        if (failed) parts.push(color.red(`${failed} failed`));
        if (report.removed.length) parts.push(`${plural(report.removed.length, "file")} removed`);
        console.log(`${report.aborted ? color.yellow("Stopped") : "Done"} in ${seconds}s · ${parts.join(" · ")}`);
        if (report.bytes.before) {
          console.log(`${color.dim("Sizes ")} ${formatBytes(report.bytes.before)} → ${formatBytes(report.bytes.after)}${saved(report.bytes.before, report.bytes.after)} ${color.dim("for the widest screens")}`);
        }
      }
      if (report.markup) console.log(`${color.dim("Markup")} ${rel(report.markup)}`);
    },
    dryRun(plan) {
      console.log(`${color.bold("Dry run")} — nothing was written.`);
      if (plan.encode.length) {
        console.log(`Would encode ${plural(plan.encode.length, "file")}:`);
        for (const e of plan.encode) console.log(`  ${name(e.source)} ${color.dim(e.reason)}`);
      }
      if (plan.unchanged.length) console.log(`Unchanged: ${plan.unchanged.length}`);
      if (plan.remove.length) {
        console.log(`Would remove ${plural(plan.remove.length, "file")}:`);
        for (const f of plan.remove) console.log(`  ${f}`);
      } else if (plan.stale.length) {
        console.log(`${plural(plan.stale.length, "source")} no longer exist — add --clean to remove their outputs`);
      }
      for (const s of plan.skipped) console.log(`  ${color.yellow("–")} ${name(s.source)} ${color.dim(s.reason)}`);
      if (!plan.encode.length && !plan.remove.length) console.log(`${color.green("✓")} Everything is up to date`);
    },
  };
}

async function direct(input, options, run, values, cwd) {
  const reporter = createReporter(values, cwd);
  const settings = resolveOptions(input, options, { cwd });
  const plan = await planRun(settings, run);

  if (run.dryRun) {
    const described = describePlan(plan);
    if (values.json) printJson(described);
    else reporter.dryRun(described);
    return 0;
  }

  reporter.header(settings);
  const controller = new AbortController();
  const release = onInterrupt(controller, reporter.say);
  const report = await executePlan(plan, {
    clean: run.clean,
    signal: controller.signal,
    onTask: reporter.task,
    onProgress: reporter.progress,
  });
  release();

  if (values.json) printJson(report);
  else reporter.summary(report);
  return report.aborted ? 130 : report.ok ? 0 : 1;
}

async function watchMode(input, options, values, cwd) {
  const reporter = createReporter(values, cwd);
  const watcher = watch(input, { ...options, cwd, onTask: reporter.task, onProgress: reporter.progress }, {
    onRun: (report) => (values.json ? printJson(report) : reporter.summary(report)),
    onError: (error) => reporter.error(error),
  });
  reporter.header(watcher.settings);
  await watcher.ready;
  if (!values.json && !values.quiet) {
    console.log(color.dim(`Watching ${relTo(cwd)(watcher.settings.input)} — Ctrl+C to stop`));
  }
  await new Promise((resolve) => process.once("SIGINT", resolve));
  watcher.close();
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────
// Guided mode and init
// ─────────────────────────────────────────────────────────────────────────

const CANDIDATE_FOLDERS = ["media", "assets", "src/assets", "public", "static", "images", "img", "photos", "videos"];

/** Folders here that look like they hold media, busiest first. */
function detectMediaFolders(cwd) {
  const found = [];
  for (const candidate of CANDIDATE_FOLDERS) {
    const dir = path.join(cwd, candidate);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    if (fs.existsSync(path.join(dir, "webready.json"))) continue; // an output folder
    const scan = scanMedia(dir);
    const count = scan.images.length + scan.videos.length;
    if (count) found.push({ dir, rel: candidate, scan, count });
  }
  return found.sort((a, b) => b.count - a.count);
}

function describeScan(scan) {
  const parts = [];
  if (scan.images.length) parts.push(`${plural(scan.images.length, "image")} (${formatBytes(sumBytes(scan.images))})`);
  if (scan.videos.length) parts.push(`${plural(scan.videos.length, "video")} (${formatBytes(sumBytes(scan.videos))})`);
  return parts.join(" · ") || "no images or videos";
}

function describeSettings(settings) {
  const images = settings.images.formats.map((f) => `${FORMAT_NAMES[f]} ${settings.images.quality[f]}`).join(" + ");
  return `${images} · ${settings.widths.join("/")} · MP4 ${settings.videos.quality}`;
}

async function ask(prompt) {
  const value = await prompt;
  if (p.isCancel(value)) {
    p.cancel("Cancelled — nothing was written.");
    throw new Cancelled();
  }
  return value;
}

async function chooseFolder(cwd, message) {
  const folders = detectMediaFolders(cwd);
  if (folders.length) {
    const choice = await ask(p.select({
      message,
      options: [
        ...folders.map((f) => ({ value: f.dir, label: f.rel, hint: describeScan(f.scan) })),
        { value: "", label: "Another folder…" },
      ],
    }));
    if (choice) return choice;
  }
  const typed = await ask(p.path({
    message: folders.length ? "Which folder?" : message,
    directory: true,
    root: cwd,
    validate: (value) =>
      value && fs.existsSync(path.resolve(cwd, value)) && fs.statSync(path.resolve(cwd, value)).isDirectory()
        ? undefined
        : "That isn't a folder",
  }));
  return path.resolve(cwd, typed);
}

const QUALITY_PRESETS = {
  avif: [
    { value: 80, label: "Ultra", hint: "80 — near transparent" },
    { value: 60, label: "Balanced", hint: "60 — recommended" },
    { value: 45, label: "Economic", hint: "45 — smallest files" },
  ],
  webp: [
    { value: 90, label: "Ultra", hint: "90 — near transparent" },
    { value: 80, label: "Balanced", hint: "80 — recommended" },
    { value: 70, label: "Economic", hint: "70 — smallest files" },
  ],
};
const WIDTH_CHOICES = [320, 480, 640, 768, 1024, 1280, 1440, 1600, 1920, 2560, 3840];

/** The Custom questions. Returns options (config keys). */
async function customSettings({ cwd, input, options, hasVideos }) {
  const current = resolveOptions(input, options, { cwd });
  const rel = relTo(cwd);

  const formats = await ask(p.multiselect({
    message: "Image formats",
    options: [
      { value: "avif", label: "AVIF", hint: "smallest files" },
      { value: "webp", label: "WebP", hint: "widest support, fast to encode" },
    ],
    initialValues: current.images.formats,
    required: true,
  }));
  const widths = await ask(p.multiselect({
    message: "Rendition widths",
    options: [...new Set([...WIDTH_CHOICES, ...current.widths])].sort((a, b) => a - b).map((w) => ({ value: w, label: `${w}px` })),
    initialValues: current.widths,
    required: true,
  }));
  const quality = {};
  for (const format of formats) {
    quality[format] = await ask(p.select({
      message: `${FORMAT_NAMES[format]} quality`,
      options: QUALITY_PRESETS[format],
      initialValue: current.images.quality[format] ?? DEFAULT_QUALITY[format],
    }));
  }
  const effort = await ask(p.select({
    message: "Encoder effort",
    options: [
      { value: 2, label: "Fast" },
      { value: 4, label: "Balanced", hint: "recommended" },
      { value: 6, label: "Smallest files", hint: "slower" },
    ],
    initialValue: current.images.effort,
  }));

  const videos = {};
  if (hasVideos) {
    videos.quality = await ask(p.select({
      message: "Video quality",
      options: [
        { value: 90, label: "High", hint: "90" },
        { value: 80, label: "Balanced", hint: "80 — recommended" },
        { value: 65, label: "Small", hint: "65" },
      ],
      initialValue: current.videos.quality,
    }));
    videos.preset = await ask(p.select({
      message: "Video encoding speed",
      options: [
        { value: "veryfast", label: "Fast", hint: "larger files" },
        { value: "medium", label: "Balanced", hint: "recommended" },
        { value: "slow", label: "Smallest files", hint: "slower" },
      ],
      initialValue: X264_PRESETS.includes(current.videos.preset) ? current.videos.preset : "medium",
    }));
  }

  const out = await ask(p.text({ message: "Output folder", initialValue: rel(current.out) }));
  const publicPath = await ask(p.text({
    message: "URL the output folder is served at (leave empty for relative paths)",
    placeholder: "/media",
    initialValue: current.publicPath ?? "",
  }));
  const markup = await ask(p.select({
    message: "Markup",
    options: [
      { value: "srcset", label: "srcset", hint: "browser picks by size and screen density — recommended" },
      { value: "media", label: "media", hint: "picks by viewport width" },
      { value: "none", label: "none", hint: "manifest only" },
    ],
    initialValue: current.markup,
  }));

  return {
    out: path.resolve(cwd, out),
    publicPath: publicPath.trim() || undefined,
    widths,
    markup,
    images: { format: formats, quality, effort },
    videos,
  };
}

/** webready.config.json contents for these settings. */
function configJson(cwd, settings) {
  const rel = (target) => path.relative(cwd, target).split(path.sep).join("/") || ".";
  const config = {
    $schema: "./node_modules/webready/schema.json",
    input: rel(settings.input),
    out: rel(settings.out),
  };
  if (settings.publicPath) config.publicPath = settings.publicPath;
  config.widths = settings.widths;
  config.images = {
    format: settings.images.formats,
    quality: settings.images.quality,
    effort: settings.images.effort,
  };
  if (settings.images.lossless) config.images.lossless = true;
  config.videos = { ...settings.videos };
  config.markup = settings.markup;
  return `${JSON.stringify(config, null, 2)}\n`;
}

async function guided({ cwd, options, run, configPath }) {
  const rel = relTo(cwd);
  p.intro(`${color.bold("webready")} ${color.dim(VERSION)}`);

  // 1. Folder
  const input = await chooseFolder(cwd, "Which folder should be made web-ready?");

  // 2. Scan
  const scan = scanMedia(input);
  p.log.info(`Found ${describeScan(scan)}`);
  if (scan.skipped.length) {
    const shown = scan.skipped.slice(0, 6).map((s) => `${s.source} — ${s.reason}`);
    if (scan.skipped.length > 6) shown.push(`…and ${scan.skipped.length - 6} more`);
    p.log.warn(`Skipping ${plural(scan.skipped.length, "file")}:\n${shown.join("\n")}`);
  }
  if (!scan.images.length && !scan.videos.length) {
    p.outro("Nothing to convert here.");
    return 0;
  }

  // 3. Settings
  const recommended = resolveOptions(input, options, { cwd });
  const mode = await ask(p.select({
    message: "Settings",
    options: [
      { value: "recommended", label: "Recommended", hint: describeSettings(recommended) },
      { value: "custom", label: "Custom" },
    ],
  }));
  const chosen = mode === "custom"
    ? mergeOptions(options, await customSettings({ cwd, input, options, hasVideos: scan.videos.length > 0 }))
    : options;
  const settings = resolveOptions(input, chosen, { cwd });

  // 4. Plan
  const plan = await planRun(settings, run);
  const replacing = plan.tasks.filter((t) => t.previous).length;
  const lines = [`Output   ${rel(settings.out)}`, `Encode   ${plural(plan.tasks.length, "file")}`];
  if (plan.unchanged.length) lines.push(`Skip     ${plan.unchanged.length} unchanged`);
  if (replacing) lines.push(`Replace  the outputs of ${plural(replacing, "file")}`);
  if (run.clean && plan.stale.length) lines.push(`Remove   the outputs of ${plural(plan.stale.length, "deleted file")}`);
  p.note(lines.join("\n"), "Plan");

  if (!plan.tasks.length && !(run.clean && plan.stale.length)) {
    p.outro("Everything is up to date.");
    return 0;
  }
  if (!(await ask(p.confirm({ message: "Start?" })))) {
    p.cancel("Nothing was written.");
    return 0;
  }

  // 5. Progress
  const bar = p.progress({ max: Math.max(1, plan.tasks.length) });
  bar.start("Encoding…");
  const controller = new AbortController();
  const release = onInterrupt(controller, (message) => bar.message(message));
  const report = await executePlan(plan, {
    clean: run.clean,
    signal: controller.signal,
    onTask: ({ task, error, before, after }) =>
      bar.advance(1, error
        ? `${task.file.rel} failed`
        : `${task.file.rel}  ${formatBytes(before)} → ${formatBytes(after)}`),
    onProgress: ({ task, width, percent }) => bar.message(`${task.file.rel}  ${width}px ${Math.round(percent)}%`),
  });
  release();
  const converted = report.images.converted + report.videos.converted;
  bar.stop(report.aborted
    ? `Stopped after ${plural(converted, "file")}`
    : `Converted ${plural(converted, "file")} in ${(report.durationMs / 1000).toFixed(1)}s`);

  // 6. Report
  const summary = [];
  if (report.bytes.before) {
    summary.push(`Sizes    ${formatBytes(report.bytes.before)} → ${formatBytes(report.bytes.after)}${saved(report.bytes.before, report.bytes.after)} for the widest screens`);
  }
  if (report.markup) summary.push(`Markup   ${rel(report.markup)}`);
  summary.push(`Manifest ${rel(report.manifest)}`);
  p.note(summary.join("\n"), "Report");
  for (const e of report.errors) p.log.error(`${e.source}\n${firstLine(e.message)}`);
  for (const s of report.skipped) p.log.warn(`${s.source} — ${s.reason}`);

  if (!configPath) {
    const save = await ask(p.confirm({
      message: `Save these settings to ${CONFIG_FILE}, so next time \`webready\` just runs?`,
      initialValue: true,
    }));
    if (save) {
      fs.writeFileSync(path.join(cwd, CONFIG_FILE), configJson(cwd, settings));
      p.log.success(`Saved ${CONFIG_FILE}`);
    }
  }

  p.outro(report.ok ? "Your media is web-ready." : report.aborted ? "Stopped." : "Done, with the errors above.");
  return report.aborted ? 130 : report.ok ? 0 : 1;
}

async function init({ cwd, values }) {
  if (!canPrompt(values)) {
    throw new ConfigError(
      `webready init asks a few questions, so it needs a terminal. You can also write ${CONFIG_FILE} by hand — see the README.`,
    );
  }
  const target = path.resolve(cwd, values.config ?? CONFIG_FILE);
  const rel = relTo(cwd);
  p.intro(`${color.bold("webready init")} ${color.dim(VERSION)}`);

  if (fs.existsSync(target)) {
    const replace = await ask(p.confirm({ message: `${rel(target)} already exists. Replace it?`, initialValue: false }));
    if (!replace) {
      p.outro("Kept your config.");
      return 0;
    }
  }

  const input = await chooseFolder(cwd, "Where are your original images and videos?");
  // Serving from public/: suggest public/<name>, served at /<name>.
  const suggestion = {};
  if (fs.existsSync(path.join(cwd, "public"))) {
    const name = path.basename(input) === "public" ? "media" : path.basename(input);
    suggestion.out = path.join(cwd, "public", name);
    suggestion.publicPath = `/${name}`;
  }
  const scan = scanMedia(input);
  const options = await customSettings({ cwd, input, options: suggestion, hasVideos: scan.videos.length > 0 });
  const settings = resolveOptions(input, options, { cwd });

  fs.writeFileSync(target, configJson(path.dirname(target), settings));
  p.outro(`Saved ${rel(target)} — run ${color.bold("webready")} to convert.`);
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    throw new ConfigError(`${error.message}\nRun "webready --help" for the options.`);
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    console.log(VERSION);
    return 0;
  }

  const cwd = process.cwd();
  const [first, ...rest] = positionals;
  if (rest.length) throw new ConfigError(`Expected one folder, got: ${positionals.join(" ")}`);
  if (first === "init") return init({ cwd, values });

  const file = loadConfigFile({ cwd, file: values.config });
  const options = mergeOptions(file.config, optionsFromFlags(values, { cwd }));
  const input = first ?? options.input;
  const run = { force: Boolean(values.force), clean: Boolean(values.clean), dryRun: Boolean(values["dry-run"]) };

  if (!input) {
    if (!canPrompt(values)) {
      throw new ConfigError(`No input folder: pass one (webready ./media) or set "input" in ${CONFIG_FILE}`);
    }
    return guided({ cwd, options, run, configPath: file.path });
  }
  if (values.watch) return watchMode(input, options, values, cwd);
  return direct(input, options, run, values, cwd);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code ?? 0;
  },
  (error) => {
    if (error instanceof Cancelled) {
      process.exitCode = 130;
    } else if (error?.exitCode === 2) {
      console.error(`${color.red("webready:")} ${error.message}`);
      process.exitCode = 2;
    } else {
      console.error(`${color.red("webready:")} ${error?.stack || error}`);
      process.exitCode = 1;
    }
  },
);
