// Watch mode: run once, then again whenever the input folder changes.

import fs from "node:fs";
import path from "node:path";
import { resolveOptions } from "../config.js";
import { planRun, executePlan } from "./run.js";

/**
 * Convert `input`, then keep its outputs in step with it: added and changed
 * files are encoded, deleted files' outputs removed.
 *
 * @param {string} [input]
 * @param {object} [options]  as for webready(), plus `delay` (ms, default 300)
 * @param {{onRun?: (report) => void, onError?: (error) => void}} [hooks]
 * @returns {{settings: object, ready: Promise<void>, close: () => void}}
 *   `ready` settles after the first run.
 */
export function watch(input, options = {}, { onRun, onError } = {}) {
  const { cwd, delay = 300, onStart, onTask, onProgress, ...config } = options;
  const settings = resolveOptions(input, config, { cwd });
  let timer = null;
  let running = false;
  let again = false;
  let closed = false;
  let first = true;

  const run = async () => {
    if (closed) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      const plan = await planRun(settings, { clean: true });
      if (first || plan.tasks.length || plan.stale.length) {
        onRun?.(await executePlan(plan, { clean: true, onStart, onTask, onProgress }));
      }
    } catch (error) {
      onError?.(error);
    } finally {
      first = false;
      running = false;
      if (again && !closed) {
        again = false;
        schedule();
      }
    }
  };

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(run, delay);
  };

  // Changes inside the output folder - if it lives in the input - and to
  // hidden files are not ours to react to.
  const outRel = path.relative(settings.input, settings.out);
  const outInside = outRel && !outRel.startsWith("..") && !path.isAbsolute(outRel);
  const ignored = (name) => {
    const rel = String(name).split(path.sep).join("/");
    if (rel.split("/").some((part) => part.startsWith("."))) return true;
    if (outInside) {
      const out = outRel.split(path.sep).join("/");
      return rel === out || rel.startsWith(`${out}/`);
    }
    return false;
  };

  const watcher = fs.watch(settings.input, { recursive: true }, (_event, name) => {
    if (name && ignored(name)) return;
    schedule();
  });

  const ready = run();
  return {
    settings,
    ready,
    close() {
      closed = true;
      clearTimeout(timer);
      watcher.close();
    },
  };
}
