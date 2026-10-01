# webready

**Make your media web-ready.** Point `webready` at a folder of images and videos and get every responsive size in modern formats, the markup to use them, and components for React and Vue — plus a browser module that shrinks photos before your users upload them.

[![npm](https://img.shields.io/npm/v/webready)](https://www.npmjs.com/package/webready)
[![CI](https://github.com/sajjadlabs/webready/actions/workflows/ci.yml/badge.svg)](https://github.com/sajjadlabs/webready/actions/workflows/ci.yml)
[![Node](https://img.shields.io/node/v/webready)](package.json)
[![License: MIT](https://img.shields.io/npm/l/webready)](LICENSE)

![webready's guided flow in a terminal](docs/demo.gif)

```bash
npx webready            # guided: pick a folder, review the plan, go
npx webready ./media    # straight to work, with the defaults
```

## Contents

- [Why](#why)
- [What you get](#what-you-get)
- [Install](#install)
- [The command](#the-command)
- [Config file](#config-file)
- [Incremental builds and watch mode](#incremental-builds-and-watch-mode)
- [React and Vue](#react-and-vue)
- [Browser build: shrink photos before upload](#browser-build-shrink-photos-before-upload)
- [Node API](#node-api)
- [Recipes](#recipes)
- [Formats and browser support](#formats-and-browser-support)
- [Limitations](#limitations)
- [Contributing](#contributing)
- [License](#license)

## Why

A single 4000-pixel JPEG costs a phone user several megabytes to show a 400-pixel picture. The fix is well known — several sizes in a modern format, and markup that lets the browser pick — but making renditions by hand for every image and video, and keeping the `srcset` in step, is tedious enough that it rarely happens.

`webready` does it in one command, for images **and** video, and on later runs only redoes what changed. It fits any stack: the output is plain files, plain HTML, and a JSON manifest, with optional components for React and Vue.

## What you get

```
media/                    media-web/
├── hero.jpg          →   ├── hero-640.avif  hero-1024.avif  hero-1440.avif  hero-1920.avif
├── team/                 ├── team/
│   └── sara.png          │   └── sara-640.avif  sara-1024.avif
└── intro.mov             ├── intro-640.mp4  …  intro-1920.mp4  intro-poster.avif
                          ├── webready.json    the manifest (and the incremental cache)
                          └── webready.html    ready-to-paste markup
```

- **Images** (`jpg`, `jpeg`, `png`, `webp`, `avif`, `tiff`, `gif`) become AVIF, WebP, or both, at your breakpoint widths.
- **Videos** (`mp4`, `mov`, `webm`, `mkv`, `avi`, `m4v`) become MP4 (H.264/AAC) at the same widths, with a poster image, encoded for instant playback on every device.
- **Nothing is ever upscaled**: the largest rendition is capped at the source's width. Your folder structure is mirrored.
- **`webready.html`** holds the markup for every file, ready to paste:

```html
<picture>
  <source type="image/avif" sizes="100vw"
          srcset="/media/hero-640.avif 640w, /media/hero-1024.avif 1024w, /media/hero-1440.avif 1440w, /media/hero-1920.avif 1920w">
  <source type="image/webp" sizes="100vw"
          srcset="/media/hero-640.webp 640w, /media/hero-1024.webp 1024w, /media/hero-1440.webp 1440w, /media/hero-1920.webp 1920w">
  <img src="/media/hero-1920.webp" alt="" width="1920" height="1280" loading="lazy" decoding="async">
</picture>

<video controls playsinline preload="metadata" width="1920" height="1080" poster="/media/intro-poster.webp">
  <source src="/media/intro-1920.mp4" media="(min-width: 1441px)" type="video/mp4">
  <source src="/media/intro-1440.mp4" media="(min-width: 1025px)" type="video/mp4">
  <source src="/media/intro-1024.mp4" media="(min-width: 641px)" type="video/mp4">
  <source src="/media/intro-640.mp4" type="video/mp4">
</video>
```

The `width` and `height` on every `<img>` let the browser reserve space before the image loads, so nothing jumps.

## Install

```bash
npm i -D webready    # per project — recommended
npm i -g webready    # or globally
npx webready         # or without installing
```

Requires **Node.js 20** or later, on macOS, Linux or Windows.

Videos need **ffmpeg**, looked up in this order:

1. the `FFMPEG_PATH` environment variable;
2. [`ffmpeg-static`](https://www.npmjs.com/package/ffmpeg-static), if you install it — an optional peer dependency, never downloaded unless you ask. It downloads ffmpeg in an install script, which recent versions of npm run only once you approve it:

   ```bash
   npm i -D ffmpeg-static
   npm approve-scripts ffmpeg-static
   npm rebuild ffmpeg-static    # if the install skipped the download
   ```

3. `ffmpeg` on your `PATH`.

Without ffmpeg, videos are skipped with a warning and images still work.

## The command

```bash
webready                      # guided mode
webready ./media              # convert ./media with the defaults (or your config file)
webready ./media -o public/media -f avif,webp -w 640,1280,1920
webready ./media --dry-run    # show the plan, write nothing
webready ./media --watch      # keep running and update outputs as files change
webready init                 # guided setup that writes webready.config.json
```

**Guided mode** runs when you start `webready` in a terminal without arguments:

1. **Folder** — suggests the media folders it finds (`public/`, `static/`, `src/assets`, `assets/`…) with file counts and sizes, or type a path with autocomplete.
2. **Scan** — shows what it found and what it will skip, and why.
3. **Settings** — *Recommended* (spelled out right there) or *Custom*.
4. **Plan** — the output folder, how many files will be written, and anything that would be overwritten. Confirm to start.
5. **Progress** — one line per file with its size before and after. Ctrl+C stops cleanly.
6. **Report** — sizes saved and time taken, any errors with a hint to fix them, where the markup is — and an offer to save your settings, so next time `webready` just runs.

Without a terminal (CI, scripts), or with `--yes`, it never prompts.

### Options

| Flag | Config key | Default | |
|---|---|---|---|
| `-o, --out <dir>` | `out` | `<input>-web` | Output folder |
| `--public-path <url>` | `publicPath` | relative paths | URL prefix used in the markup and manifest, e.g. `/media` |
| `-f, --format <list>` | `images.format` | `avif` | `avif`, `webp`, or both: `avif,webp` |
| `-w, --widths <list>` | `widths` | `640,1024,1440,1920` | Rendition widths, in pixels |
| `-q, --quality <1-100>` | `images.quality` | AVIF 60 · WebP 80 | Image quality, for every format |
| `--effort <n>` | `images.effort` | `4` | Encoder effort: AVIF 0–9, WebP 0–6. Higher is smaller and slower |
| `--lossless` | `images.lossless` | off | Lossless images — rarely worth it for the web |
| `--video-quality <1-100>` | `videos.quality` | `80` | Mapped to x264 CRF |
| `--preset <name>` | `videos.preset` | `medium` | x264 preset: slower means smaller files at the same quality |
| `--no-poster` | `videos.poster` | on | Don't make poster images |
| `--only <images\|videos>` | `only` | both | Process one kind only |
| `--markup <srcset\|media\|none>` | `markup` | `srcset` | Style of `webready.html` — see [below](#srcset-or-media) |
| `--concurrency <n>` | `concurrency` | CPU cores | Images encoded in parallel |
| `--watch` | | | Keep running and update outputs as sources change |
| `--dry-run` | | | Show the plan, write nothing |
| `--force` | | | Re-encode everything, even unchanged files |
| `--clean` | | | Delete outputs whose sources are gone |
| `-y, --yes` | | | Never prompt |
| `--json` | | | Print a machine-readable report to stdout |
| `--quiet` | | | Print errors only |
| `-c, --config <file>` | | `webready.config.json` | The config file to use |
| `-v, --version` · `-h, --help` | | | |

Exit codes: `0` success · `1` some files failed · `2` a usage or config error · `130` stopped with Ctrl+C.

With `--watch --json`, each run prints its own report.

### `srcset` or `media`?

The default `srcset` markup lets the **browser** choose, and it also accounts for screen density: a 400-pixel slot on a retina phone gets the 1024-pixel image. That's what you want for most images. Tell it how wide the image is displayed with `sizes`:

```html
<source type="image/avif" sizes="(min-width: 64rem) 50vw, 100vw" srcset="…">
```

`media` markup picks by viewport width alone — explicit and predictable, for art direction. Videos always use `media`, because `<video>` has no `srcset`. Their source is chosen once, when the element loads; resizing or rotating the device doesn't switch it.

## Config file

Put your settings in `webready.config.json`, and a plain `webready` does the rest:

```json
{
  "$schema": "./node_modules/webready/schema.json",
  "input": "media",
  "out": "public/media",
  "publicPath": "/media",
  "widths": [640, 1024, 1440, 1920],
  "images": {
    "format": ["avif", "webp"],
    "quality": { "avif": 60, "webp": 80 },
    "effort": 4
  },
  "videos": { "quality": 80, "preset": "medium", "poster": true },
  "markup": "srcset"
}
```

The `$schema` line gives you autocomplete and validation in VS Code and other editors. `webready init` writes this file for you, from a few questions.

Flags override the config file, which overrides the defaults. `images.quality` is a single number or one per format — AVIF 60 and WebP 80 look about the same, so a shared number is rarely right when you output both.

## Incremental builds and watch mode

`webready.json` records a fingerprint of every source and the settings used for it. The next run skips anything unchanged, so running `webready` before every build costs almost nothing. `--force` re-encodes everything; `--clean` removes outputs whose sources were deleted.

`webready --watch` stays running during development: add, change or delete a file and its outputs, the manifest and the markup follow within seconds.

## React and Vue

Bind the components to your manifest once:

```js
// src/media.js
import { createMedia } from "webready/react";   // or "webready/vue"
import manifest from "../public/media/webready.json";

export const { Picture, Video } = createMedia(manifest);
```

Then use them anywhere, with the source's path as `src`:

```jsx
import { Picture, Video } from "./media";

<Picture src="hero.jpg" alt="The pool at sunset" sizes="(min-width: 64rem) 50vw, 100vw" priority />
<Video src="intro.mov" autoPlay muted loop playsInline />
```

```vue
<script setup>
import { Picture, Video } from "./media";
</script>

<template>
  <Picture src="hero.jpg" alt="The pool at sunset" sizes="(min-width: 64rem) 50vw, 100vw" priority />
  <Video src="intro.mov" autoplay muted loop playsinline />
</template>
```

- `<Picture>` renders a `<source>` per format and an `<img>` with `width`, `height`, `loading="lazy"` and `decoding="async"`. `sizes` defaults to `100vw`.
- `priority` is for the image that appears first on screen (usually your largest, the LCP): it loads eagerly with `fetchpriority="high"`.
- `<Video>` shows controls unless it autoplays — autoplaying videos are usually decoration. Pass `controls` to have them anyway.
- Other props go to the `<img>` or `<video>`. An unknown `src` logs a warning in development and renders nothing.
- Both render on the server as well as in the browser. `react` and `vue` are optional peer dependencies.

## Browser build: shrink photos before upload

Phone photos are several megabytes each. `webready/browser` resizes and re-encodes them in the user's browser before upload — typically to a few hundred kilobytes, so uploads are faster and fail less on mobile data:

```js
import { compressImages } from "webready/browser";

input.addEventListener("change", async () => {
  const { entries, errors } = await compressImages(input.files, { maxDimension: 2560 });
  for (const { file } of entries) await upload(file);   // `file` is a File
  for (const { file, message } of errors) console.warn(file.name, message);
});
```

Each photo is decoded with its EXIF orientation applied, scaled so its longer side fits `maxDimension` (never up), and re-encoded. Re-encoding drops all metadata — **including GPS coordinates**, which phones embed in every photo.

| Option | Default | |
|---|---|---|
| `maxDimension` | `2560` | Longest side of the output, in pixels |
| `format` | `"webp"` | `"webp"`, `"jpeg"` or `"avif"` |
| `fallbackFormat` | `"jpeg"` | Used when the browser can't encode `format` |
| `quality` | `0.82` | Encoder quality, 0–1 |
| `keepOriginalIfSmaller` | `true` | Return the input untouched when it already fits, is in an accepted format, and re-encoding wouldn't shrink it. A kept file also keeps its metadata — set `false` to always strip it |
| `useWorker` | `true` | Work in a Web Worker when the browser supports `OffscreenCanvas` |

`compressImage(file, options)` handles one file and resolves to `{ file, width, height, type, sourceWidth, sourceHeight, originalBytes, bytes, kept }`. `compressImages(files, options, { concurrency, onProgress })` handles many — one at a time by default, since decoding a 12-megapixel photo takes about 48 MB — and collects failures instead of throwing. `canEncode("webp")` tells you what the browser can produce.

Good to know:

- **Safari can't encode WebP from a canvas.** Asked for WebP, it silently returns PNG, so `webready/browser` checks what it actually got and re-encodes as `fallbackFormat`. On iPhones — where every browser uses Safari's engine — you get JPEG. No browser encodes AVIF from a canvas today, so `"avif"` falls back too.
- **The worker needs no bundler setup.** It's created from the module's own code, so there's no separate file to configure. It needs a build target that keeps `async` functions native (ES2017 or later — Vite's default). If a Content-Security-Policy blocks `blob:` workers, the work moves to the main thread.
- **Images the browser can't read** — HEIC in Chrome, for example — fail with `code: "decode_failed"`, so you can upload the original instead.
- **Safe to import during server rendering**: nothing touches the browser until you call it.

## Node API

Everything the command does is available in code:

```js
import { webready } from "webready";

const report = await webready("media", {
  out: "public/media",
  publicPath: "/media",
  images: { format: ["avif", "webp"] },
});

if (report.errors.length) process.exitCode = 1;
```

The options are the config file's keys, plus `force`, `clean`, `dryRun` and an AbortSignal as `signal`; the report is what `--json` prints. `watch(input, options, { onRun })` is watch mode. For custom pipelines the building blocks are exported too: `scanMedia`, `optimizeImages`, `optimizeVideos`, `renderMarkup` and `resolveFfmpeg`.

## Recipes

### Vite, React Router, Nuxt, Astro…

Keep your originals outside the public folder, and let `webready` fill it:

```json
{
  "scripts": {
    "dev": "vite",
    "dev:media": "webready --watch",
    "prebuild": "webready --yes",
    "build": "vite build"
  }
}
```

With `"input": "media"`, `"out": "public/media"` and `"publicPath": "/media"` in your config, `npm run build` refreshes only what changed, then builds. If you commit the output folder, `webready.json` goes with it, and CI only encodes what changed.

A folder containing a `webready.json` is an output folder and is never read as input, so outputs can live inside a folder you also scan, such as `public/`.

### CI

```bash
npx webready --yes --json > webready-report.json
```

The exit code is `1` if any file failed, so the job fails with it, and the report says which files and why.

### An upload form

See [Browser build](#browser-build-shrink-photos-before-upload). Compress, then upload the returned `File` as usual — a `FormData` field or a presigned `PUT` both work.

## Formats and browser support

- **AVIF** is the smallest, and supported by every current browser: Chrome 85+, Firefox 93+, Safari 16.1+.
- **WebP** is supported everywhere else that matters, and encodes much faster. Output both (`-f avif,webp`) and browsers take AVIF when they can and WebP otherwise; the `<img>` fallback and video posters use WebP.
- **MP4 with H.264/AAC** plays on every device. Videos are encoded with `-pix_fmt yuv420p -profile:v high -movflags +faststart`, so they start playing before they finish downloading.

AVIF quality numbers aren't comparable with WebP or JPEG: AVIF 50–65 usually looks like WebP 75–85.

## Limitations

- **HEIC** (the iPhone camera format) can't be read by the prebuilt image library. Convert those to JPEG first, or let the browser build do it in Safari.
- **Animated GIFs** become still images (the first frame).
- **Same-name sources** in one folder — `hero.jpg` and `hero.png` — would produce the same output files, so `webready` stops and names them. Rename one.

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
npm test               # the full suite: real sharp and ffmpeg, then the browser build
npm run test:browser   # just the browser build
```

## License

[MIT](LICENSE) © [Sajjad Karimi](https://github.com/sajjadlabs)
