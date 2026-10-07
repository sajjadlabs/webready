/**
 * Tests of webready/heic. heic-to is an optional peer, not installed here, so
 * a stand-in is put in its place with Node's module hooks; it records how it
 * was called.
 *
 * Run with: node test/heic.test.mjs
 */
import { register } from "node:module";

const STAND_IN = `
  export const calls = [];
  export async function isHeic(file) { return /\\.(heic|heif)$/i.test(file.name); }
  export async function heicTo(options) {
    calls.push(options);
    return new Blob(["jpeg bytes"], { type: options.type });
  }
`;
register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, next) {
    if (specifier === "heic-to") {
      return { url: "data:text/javascript," + encodeURIComponent(${JSON.stringify(STAND_IN)}), shortCircuit: true };
    }
    return next(specifier, context);
  }
`)}`);

let failures = 0;
const must = (cond, msg) => {
  if (cond) console.log(`  OK   ${msg}`);
  else { console.error(`  FAIL ${msg}`); failures++; }
};

const { decodeHeic } = await import("../src/heic/index.js");
const { calls } = await import("heic-to");

console.log("webready/heic:");
const heic = new File([new Uint8Array(100)], "IMG_0001.HEIC", { type: "" });
const jpeg = await decodeHeic(heic);
must(jpeg instanceof Blob && jpeg.type === "image/jpeg", "a HEIC photo becomes a JPEG the browser can read");
must(calls[0].blob === heic && calls[0].type === "image/jpeg" && calls[0].quality === 0.92, "decoded at high quality: it's an intermediate step");
await decodeHeic(heic, { quality: 0.8 });
must(calls[1].quality === 0.8, "the quality can be set");

let error = null;
try { await decodeHeic(new File([new Uint8Array(100)], "notes.pdf", { type: "application/pdf" })); } catch (e) { error = e; }
must(error?.code === "decode_failed" && calls.length === 2, "anything that isn't HEIC is refused with decode_failed, and not passed on");

console.log(failures ? `\n${failures} FAILED` : "\nAll good ✅");
process.exit(failures ? 1 : 0);
