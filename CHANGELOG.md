# Changelog

All notable changes to webready are listed here. The project follows [Semantic Versioning](https://semver.org/).

## 1.0.0

The first public release.

- **The `webready` command.** Converts a folder of images and videos into responsive renditions, a manifest (`webready.json`) and ready-to-paste markup (`webready.html`). Guided mode in a terminal; every choice also available as a flag.
- **Images** as AVIF, WebP, or both, at your breakpoint widths, with EXIF rotation applied and nothing upscaled. Quality per format.
- **Videos** as MP4 (H.264/AAC) renditions with fast start, plus a poster image. ffmpeg is found through `FFMPEG_PATH`, the optional `ffmpeg-static` package, or the `PATH`.
- **Incremental builds.** Only new and changed sources are encoded; renditions a source no longer needs are removed. `--force` and `--clean`.
- **`--watch`**, **`--dry-run`**, **`--json`** reports and meaningful exit codes for CI.
- **`webready init`** and **`webready.config.json`**, with a JSON Schema for editor autocomplete.
- **`<Picture>` and `<Video>` for React and Vue** through `createMedia(manifest)`, server-rendering safe.
- **`webready/browser`**: `compressImage` and `compressImages` shrink photos in the browser before upload — WebP where the browser can encode it, JPEG elsewhere, metadata stripped.
- **A Node API** with the same options as the config file.
