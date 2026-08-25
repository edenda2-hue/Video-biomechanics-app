// Focused regression test for a real bug: blendFrame/blendFrameSweep in
// compositing.ts computed the composited alpha as `maskBuf[p] * alpha`,
// completely discarding the anatomy image's OWN alpha channel instead of
// factoring it in. That's invisible with a fully-opaque anatomy image (the
// keyframes-smoke.mjs fixture always is), but the manual touch-alignment
// flow (AnatomyAligner.tsx) uploads anatomy PNGs that are only opaque where
// the user actually placed the image and transparent everywhere else on
// the canvas — so any part of the person-mask silhouette the user's
// placement doesn't cover was rendering literal black/garbage instead of
// falling back to the real original footage.
//
// Run against the built server: `npm run build && node scripts/compositing-alpha-smoke.mjs`
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { buildFreezeSequence } from "../dist/lib/compositing.js";

const TMP = "/tmp/vba-compositing-alpha-smoke";
const WIDTH = 200;
const HEIGHT = 200;

async function main() {
  await fs.mkdir(TMP, { recursive: true });

  // Original frame: solid blue, so any "leakage" is obvious against it.
  const originalPath = path.join(TMP, "original.png");
  await sharp({ create: { width: WIDTH, height: HEIGHT, channels: 3, background: { r: 0, g: 0, b: 255 } } })
    .png()
    .toFile(originalPath);

  // Person mask: a big circle covering most of the frame (the "real" person silhouette).
  const maskPath = path.join(TMP, "mask.png");
  await sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
        <rect width="100%" height="100%" fill="black" />
        <circle cx="${WIDTH / 2}" cy="${HEIGHT / 2}" r="90" fill="white" />
      </svg>`,
    ),
  )
    .png()
    .toFile(maskPath);

  // Anatomy image: opaque RED only in a small square in the top-left
  // corner (simulating a manually-placed, partial-coverage anatomy image),
  // fully TRANSPARENT everywhere else — including inside the mask circle,
  // most of which this "placement" does not cover.
  const anatomyPath = path.join(TMP, "anatomy.png");
  const anatomyRaw = Buffer.alloc(WIDTH * HEIGHT * 4); // all zero = transparent black
  for (let y = 20; y < 60; y++) {
    for (let x = 20; x < 60; x++) {
      const p = (y * WIDTH + x) * 4;
      anatomyRaw[p] = 255; // R
      anatomyRaw[p + 1] = 0; // G
      anatomyRaw[p + 2] = 0; // B
      anatomyRaw[p + 3] = 255; // A (opaque)
    }
  }
  await sharp(anatomyRaw, { raw: { width: WIDTH, height: HEIGHT, channels: 4 } }).png().toFile(anatomyPath);

  const outDir = path.join(TMP, "seq");
  await fs.rm(outDir, { recursive: true, force: true });
  await buildFreezeSequence({
    originalFramePath: originalPath,
    maskPath,
    anatomyImagePath: anatomyPath,
    fps: 10,
    transitionInSec: 0.1,
    holdSec: 0.2,
    transitionOutSec: 0.1,
    outDir,
    style: "dissolve", // uniform alpha, simplest to reason about
  });

  const files = (await fs.readdir(outDir)).sort();
  const holdFrame = path.join(outDir, files[Math.floor(files.length / 2)]);

  // Sample a pixel that's inside the mask circle (should be "person") but
  // OUTSIDE the anatomy image's placed red square, e.g. the mask's center.
  const { data: gap } = await sharp(holdFrame)
    .extract({ left: WIDTH / 2 - 1, top: HEIGHT / 2 - 1, width: 1, height: 1 })
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Sample a pixel that's inside BOTH the mask and the anatomy's red square.
  const { data: covered } = await sharp(holdFrame)
    .extract({ left: 39, top: 39, width: 1, height: 1 })
    .raw()
    .toBuffer({ resolveWithObject: true });

  console.log("gap pixel (mask=person, anatomy=transparent):", Array.from(gap));
  console.log("covered pixel (mask=person, anatomy=opaque red):", Array.from(covered));

  const gapIsOriginalBlue = gap[0] < 30 && gap[1] < 30 && gap[2] > 200;
  const coveredIsAnatomyRed = covered[0] > 200 && covered[1] < 30 && covered[2] < 30;

  if (!gapIsOriginalBlue) {
    console.error("FAIL: pixel outside the anatomy's own coverage, but inside the person mask, is NOT the original blue frame.");
    console.error("This is the bug: the anatomy image's own alpha channel is being discarded, so an uncovered");
    console.error("gap in the placement shows garbage/black instead of falling back to the real footage.");
    process.exit(1);
  }
  if (!coveredIsAnatomyRed) {
    console.error("FAIL: pixel where the anatomy image IS opaque did not composite as anatomy content — compositing is broken in the other direction.");
    process.exit(1);
  }

  console.log("\nPASS: gap correctly falls back to original footage; covered area correctly shows anatomy content.");
}

main().catch((err) => {
  console.error("COMPOSITING ALPHA SMOKE TEST FAILED:", err);
  process.exit(1);
});
