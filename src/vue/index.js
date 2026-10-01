// <Picture> and <Video> for Vue 3. Renders on the server and in the browser.
//
//   import { createMedia } from "webready/vue";
//   import manifest from "../public/media/webready.json";
//   export const { Picture, Video } = createMedia(manifest);

import { defineComponent, h } from "vue";
import { describePicture, describeVideo, warn } from "../components/describe.js";

/**
 * Components bound to a manifest.
 * @param {object} manifest  the contents of webready.json
 */
export function createMedia(manifest) {
  // Attributes not declared as props (class, style, muted, loop…) go to the
  // <img> or <video>, not the wrapper.
  const Picture = defineComponent({
    name: "Picture",
    inheritAttrs: false,
    props: {
      src: { type: String, required: true },
      alt: { type: String, default: "" },
      sizes: { type: String, default: "100vw" },
      priority: { type: Boolean, default: false },
    },
    setup(props, { attrs }) {
      return () => {
        const picture = describePicture(manifest, props.src, props);
        if (!picture) {
          warn(`<Picture src="${props.src}">: not in the manifest — run webready, or check the path`);
          return null;
        }
        return h("picture", [
          ...picture.sources.map((s) => h("source", { type: s.type, srcset: s.srcset, sizes: s.sizes })),
          h("img", { ...picture.img, ...attrs }),
        ]);
      };
    },
  });

  const Video = defineComponent({
    name: "Video",
    inheritAttrs: false,
    props: {
      src: { type: String, required: true },
      autoplay: { type: Boolean, default: false },
      // undefined unless given, so the default can depend on autoplay.
      controls: { type: Boolean, default: undefined },
    },
    setup(props, { attrs, slots }) {
      return () => {
        const video = describeVideo(manifest, props.src, { autoplay: props.autoplay, controls: props.controls });
        if (!video) {
          warn(`<Video src="${props.src}">: not in the manifest — run webready, or check the path`);
          return null;
        }
        return h("video", { ...video.video, ...attrs }, [
          ...video.sources.map((s) => h("source", { src: s.src, media: s.media ?? undefined, type: s.type })),
          slots.default?.(),
        ]);
      };
    },
  });

  return { Picture, Video };
}
