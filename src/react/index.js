// <Picture> and <Video> for React. Renders on the server and in the browser.
//
//   import { createMedia } from "webready/react";
//   import manifest from "../public/media/webready.json";
//   export const { Picture, Video } = createMedia(manifest);

import { createElement, version } from "react";
import { describePicture, describeVideo, warn } from "../components/describe.js";

// React 19 knows fetchPriority; earlier versions pass it through lowercase.
const MODERN = Number(String(version).split(".")[0]) >= 19;
const REACT_NAMES = {
  srcset: "srcSet",
  fetchpriority: MODERN ? "fetchPriority" : "fetchpriority",
  playsinline: "playsInline",
  autoplay: "autoPlay",
};
const toReact = (attrs) =>
  Object.fromEntries(Object.entries(attrs).map(([name, value]) => [REACT_NAMES[name] ?? name, value]));

/**
 * Components bound to a manifest.
 * @param {object} manifest  the contents of webready.json
 * @returns {{Picture: Function, Video: Function}}
 */
export function createMedia(manifest) {
  /**
   * @param {{src: string, alt?: string, sizes?: string, priority?: boolean}} props
   *   Any other props go to the <img>.
   */
  function Picture({ src, alt, sizes, priority, ...rest }) {
    const picture = describePicture(manifest, src, { alt, sizes, priority });
    if (!picture) {
      warn(`<Picture src="${src}">: not in the manifest — run webready, or check the path`);
      return null;
    }
    return createElement(
      "picture",
      null,
      ...picture.sources.map((s) =>
        createElement("source", { key: s.type, type: s.type, srcSet: s.srcset, sizes: s.sizes }),
      ),
      createElement("img", { ...toReact(picture.img), ...rest }),
    );
  }

  /**
   * @param {{src: string, autoPlay?: boolean, controls?: boolean}} props
   *   Any other props (muted, loop, className…) go to the <video>.
   */
  function Video({ src, autoPlay, controls, children, ...rest }) {
    const video = describeVideo(manifest, src, { autoplay: Boolean(autoPlay), controls });
    if (!video) {
      warn(`<Video src="${src}">: not in the manifest — run webready, or check the path`);
      return null;
    }
    return createElement(
      "video",
      { ...toReact(video.video), ...rest },
      ...video.sources.map((s) =>
        createElement("source", { key: s.src, src: s.src, media: s.media ?? undefined, type: s.type }),
      ),
      children,
    );
  }

  Picture.displayName = "Picture";
  Video.displayName = "Video";
  return { Picture, Video };
}
