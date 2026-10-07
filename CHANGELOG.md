# Changelog

All notable changes to webready are listed here. The project follows [Semantic Versioning](https://semver.org/).

## 1.1.0

- **Photos that already fit are kept when re-encoding gains little.** The browser build used to re-encode an image whenever the result was any smaller — even 2% — losing a little quality for nothing. Now an original that already fits is kept unless re-encoding saves at least `minSaving` (new option, default 10%).
- **Photos with metadata are never kept.** An image carrying EXIF or XMP — where phones store the GPS position — is always re-encoded, whatever the saving, so the location can't slip through. `hasMetadata(blob)` is exported too.
- **`decode`: a fallback decoder** for images the browser can't read. It's called only when native decoding fails, and its result is shrunk as usual.
- **`webready/heic`**: HEIC/HEIF support for every browser, through the optional `heic-to` peer dependency, loaded only when a HEIC photo turns up.

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
