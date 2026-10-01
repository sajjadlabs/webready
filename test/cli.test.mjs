/**
 * Tests of the `webready` command, run as a subprocess without a terminal —
 * the way CI and npm scripts call it.
 *
 * Run with: node test/cli.test.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
let failures = 0;
const must = (cond, msg) => {
  if (cond) console.log(`  OK   ${msg}`);
  else { console.error(`  FAIL ${msg}`); failures++; }
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "webready-cli-"));
const run = (args, { cwd = root, env = {} } = {}) => {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", ...env },
  });
  return { code: res.status, out: res.stdout, err: res.stderr };
};

fs.mkdirSync(path.join(root, "media"));
await sharp({ create: { width: 800, height: 600, channels: 3, background: "#3a7" } }).jpeg().toFile(path.join(root, "media", "a.jpg"));
await sharp({ create: { width: 300, height: 200, channels: 3, background: "#a73" } }).png().toFile(path.join(root, "media", "b.png"));

console.log("basics:");
let r = run(["--help"]);
must(r.code === 0 && r.out.includes("webready <folder> [options]") && r.out.includes("--public-path"), "--help prints the usage");
r = run(["--version"]);
must(r.code === 0 && /^\d+\.\d+\.\d+\n$/.test(r.out), `--version prints the version (${r.out.trim()})`);
r = run(["media", "--qualty", "50"]);
must(r.code === 2 && /qualty/.test(r.err) && /--help/.test(r.err), "an unknown flag: exit 2, naming it");
r = run([]);
must(r.code === 2 && /No input folder/.test(r.err), "no folder and no terminal: exit 2, saying what to do");
r = run(["missing"]);
must(r.code === 2 && /Input folder not found: missing/.test(r.err), "a missing folder: exit 2");
r = run(["media", "-q", "500"]);
must(r.code === 2 && /quality/.test(r.err), "an out-of-range value: exit 2");
r = run(["init"]);
must(r.code === 2 && /needs a terminal/.test(r.err), "init without a terminal: exit 2, with the alternative");

console.log("running:");
r = run(["media", "-w", "320,640"]);
must(r.code === 0 && /a\.jpg/.test(r.out) && /Done in/.test(r.out), "a plain run lists each file and a summary");
must(fs.existsSync(path.join(root, "media-web", "a-640.avif")), "outputs land in the sibling media-web");
r = run(["media", "-w", "320,640"]);
must(r.code === 0 && /Everything is up to date/.test(r.out), "a second run: up to date");

r = run(["media", "-w", "320,640", "--json"]);
let report = null;
try { report = JSON.parse(r.out); } catch { /* checked below */ }
must(r.code === 0 && report?.images?.unchanged === 2, "--json: stdout is exactly the JSON report");

r = run(["media", "-w", "320,640,1024", "--dry-run", "--json"]);
try { report = JSON.parse(r.out); } catch { report = null; }
must(report?.dryRun && report.encode.length === 2 && report.encode[0].reason === "settings", "--dry-run --json: the plan, with reasons");
must(!fs.existsSync(path.join(root, "media-web", "a-800.avif")), "...and nothing written");

fs.writeFileSync(path.join(root, "media", "broken.jpg"), "not an image");
r = run(["media", "-w", "320,640", "--quiet"]);
must(r.code === 1, "a failed file: exit 1");
must(r.out === "" && /broken\.jpg/.test(r.err), "--quiet prints only the error");
fs.rmSync(path.join(root, "media", "broken.jpg"));

console.log("config file:");
fs.writeFileSync(path.join(root, "webready.config.json"), JSON.stringify({
  input: "media", out: "public/media", publicPath: "/media", widths: [320], images: { format: ["avif", "webp"] },
}));
r = run(["--yes"]);
must(r.code === 0 && fs.existsSync(path.join(root, "public", "media", "a-320.webp")), "the config file supplies the folder and settings");
must(fs.readFileSync(path.join(root, "public", "media", "webready.html"), "utf8").includes("/media/a-320.avif"), "...including the public path");
r = run(["--yes", "-f", "webp", "--json"]);
try { report = JSON.parse(r.out); } catch { report = null; }
must(report?.images?.converted === 2, "a flag overrides the config file (format changed: re-encoded)");
fs.writeFileSync(path.join(root, "webready.config.json"), JSON.stringify({ input: "media", widht: [320] }));
r = run(["--yes"]);
must(r.code === 2 && /unknown key "widht"/.test(r.err), "a typo in the config: exit 2, naming it");

fs.rmSync(root, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : "\nAll good ✅");
process.exit(failures ? 1 : 0);
