/**
 * Tests of <Picture> and <Video>: the shared logic always, and the real
 * React and Vue components when those are installed (they're dev
 * dependencies, so `npm install` brings them).
 *
 * Run with: node test/components.test.mjs
 */
import { describePicture, describeVideo } from "../src/components/describe.js";

let failures = 0;
const must = (cond, msg) => {
  if (cond) console.log(`  OK   ${msg}`);
  else { console.error(`  FAIL ${msg}`); failures++; }
};

const image = (format, width, height) => ({ format, width, height, bytes: 1, file: `hero-${width}.${format}` });
const manifest = {
  version: 1,
  publicPath: "/media",
  images: {
    "hero.jpg": {
      type: "image", width: 1600, height: 1067, formats: ["avif", "webp"],
      renditions: [image("avif", 640, 427), image("webp", 640, 427), image("avif", 1600, 1067), image("webp", 1600, 1067)],
    },
  },
  videos: {
    "intro.mov": {
      type: "video", width: 1280, height: 720, poster: "intro-poster.webp",
      renditions: [
        { format: "mp4", width: 640, height: 360, bytes: 1, file: "intro-640.mp4" },
        { format: "mp4", width: 1280, height: 720, bytes: 1, file: "intro-1280.mp4" },
      ],
    },
  },
};

console.log("shared logic:");
const picture = describePicture(manifest, "hero.jpg", { alt: "Pool" });
must(picture.sources.map((s) => s.type).join() === "image/avif,image/webp", "a <source> per format, AVIF first");
must(picture.sources[0].srcset === "/media/hero-640.avif 640w, /media/hero-1600.avif 1600w", "srcset narrowest first, with site URLs");
must(picture.sources[0].sizes === "100vw", "sizes defaults to 100vw");
must(picture.img.src === "/media/hero-1600.webp" && picture.img.width === 1600 && picture.img.height === 1067, "<img>: the largest WebP, with its size");
must(picture.img.loading === "lazy" && picture.img.decoding === "async" && !picture.img.fetchpriority, "lazy and async by default");
const first = describePicture(manifest, "./hero.jpg", { priority: true });
must(first.img.loading === "eager" && first.img.fetchpriority === "high", "priority: eager, fetchpriority high");
must(describePicture(manifest, "/hero.jpg") && describePicture(manifest, "nope.jpg") === null, "leading ./ or / is fine; unknown sources give null");

const video = describeVideo(manifest, "intro.mov");
must(video.sources[0].src === "/media/intro-1280.mp4" && video.sources[0].media === "(min-width: 641px)" && video.sources[1].media === null, "video sources widest first, by min-width");
must(video.video.poster === "/media/intro-poster.webp" && video.video.playsinline === true, "the poster, and playsinline");
must(video.video.controls === true && !video.video.autoplay, "controls on by default");
const background = describeVideo(manifest, "intro.mov", { autoplay: true });
must(background.video.autoplay === true && background.video.controls === false, "an autoplaying video has no controls…");
must(describeVideo(manifest, "intro.mov", { autoplay: true, controls: true }).video.controls === true, "…unless you ask for them");

const warnings = [];
const realWarn = console.warn;
console.warn = (m) => warnings.push(m);
const relative = describePicture({ ...manifest, publicPath: null }, "hero.jpg");
describePicture({ ...manifest, publicPath: null }, "hero.jpg");
console.warn = realWarn;
must(relative.img.src === "hero-1600.webp", "without publicPath, paths stay relative");
must(warnings.length === 1 && /publicPath/.test(warnings[0]), "…with one warning to set it");

const tryImport = async (name) => { try { return await import(name); } catch { return null; } };

const react = await tryImport("react");
const reactDom = await tryImport("react-dom/server");
if (react && reactDom) {
  console.log("React:");
  const { createMedia } = await import("../src/react/index.js");
  const { Picture, Video } = createMedia(manifest);
  const html = reactDom.renderToStaticMarkup(react.createElement(Picture, { src: "hero.jpg", alt: "Pool", priority: true, className: "hero" }));
  // Attribute names compared case-insensitively: React may write srcSet or srcset.
  must(/^<picture><source type="image\/avif" srcset="\/media\/hero-640\.avif 640w, \/media\/hero-1600\.avif 1600w" sizes="100vw"\/?>/i.test(html), "renders the sources");
  must(/<img [^>]*class="hero"/.test(html) && /fetchpriority="high"/i.test(html) && /loading="eager"/.test(html), "the <img>, with your props and priority");
  const v = reactDom.renderToStaticMarkup(react.createElement(Video, { src: "intro.mov", autoPlay: true, muted: true, loop: true }));
  // React 19 writes boolean attributes under their React names (autoPlay="").
  // HTML attribute names are case-insensitive, so compare that way.
  must(/autoplay=""/i.test(v) && /playsinline=""/i.test(v), "a background video autoplays, inline");
  must(!/controls/i.test(v), "…without controls");
  must(/poster="\/media\/intro-poster\.webp"/.test(v), "…with the poster");
  must(reactDom.renderToStaticMarkup(react.createElement(Picture, { src: "missing.jpg" })) === "", "an unknown src renders nothing");
} else {
  console.log("React: not installed here — skipped (npm install brings it)");
}

const vue = await tryImport("vue");
const vueServer = await tryImport("vue/server-renderer");
if (vue && vueServer) {
  console.log("Vue:");
  const { createMedia } = await import("../src/vue/index.js");
  const { Picture, Video } = createMedia(manifest);
  const render = (component, props) => vueServer.renderToString(vue.createSSRApp({ render: () => vue.h(component, props) }));
  const html = await render(Picture, { src: "hero.jpg", alt: "Pool", priority: true, class: "hero" });
  must(html.includes('<picture><source type="image/avif" srcset="/media/hero-640.avif 640w, /media/hero-1600.avif 1600w" sizes="100vw">'), "renders the sources");
  must(/<img [^>]*class="hero"/.test(html) && /fetchpriority="high"/.test(html) && /loading="eager"/.test(html), "the <img>, with your attributes and priority");
  const v = await render(Video, { src: "intro.mov", autoplay: true, muted: true, loop: true });
  must(/autoplay/i.test(v) && /playsinline/i.test(v), "a background video autoplays, inline");
  must(!/controls/i.test(v), "…without controls");
  must(/poster="\/media\/intro-poster\.webp"/.test(v), "…with the poster");
} else {
  console.log("Vue: not installed here — skipped (npm install brings it)");
}

console.log(failures ? `\n${failures} FAILED` : "\nAll good ✅");
process.exit(failures ? 1 : 0);
