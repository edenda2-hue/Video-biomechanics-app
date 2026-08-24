// Standalone mechanical smoke test for the continuous-mode compositing
// pipeline (buildContinuousSequence -> encodeImageSequence ->
// assembleContinuousVideo), independent of the HTTP routes/session state
// (which don't exist yet for this mode) or any UI. Exercises the actual
// library functions directly against a synthetic source video and
// synthetic per-frame puppet/mask PNGs, then verifies with ffprobe/cmp:
//   - output resolution/fps/duration match the source
//   - frames OUTSIDE the replaced range are pixel-identical to the source
//     (the body-only/background-lock guarantee, for the region this mode
//     doesn't touch)
//   - frames INSIDE the replaced range actually differ from the source
//     (proving the puppet content was really composited in, not a no-op)
// Run with: node scripts/continuous-smoke.mjs
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { buildContinuousSequence } from "../dist/lib/continuousComposite.js";
import { assembleContinuousVideo, encodeImageSequence, probe } from "../dist/lib/ffmpeg.js";

const run = promisify(execFile);
const WIDTH = 320;
const HEIGHT = 240;
const FPS = 12;
const DURATION = 4; // seconds
const CONTINUOUS_START = 1.0;
const CONTINUOUS_END = 2.5;

const TMP = "/tmp/vba-continuous-smoke";

async function main() {
  await fs.rm(TMP, { recursive: true, force: true });
  await fs.mkdir(TMP, { recursive: true });

  const videoPath = path.join(TMP, "source.mp4");
  console.log("1. generating a synthetic source video (distinct color per second, so per-frame identity is checkable)...");
  await run("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=${WIDTH}x${HEIGHT}:rate=${FPS}:duration=${DURATION}`,
    "-pix_fmt",
    "yuv420p",
    videoPath,
  ]);

  const metadata = await probe(videoPath);
  console.log("   source:", metadata);

  console.log(`2. building synthetic per-frame puppet+mask inputs for [${CONTINUOUS_START}, ${CONTINUOUS_END}]s...`);
  const frames = [];
  for (let t = CONTINUOUS_START; t < CONTINUOUS_END - 1e-6; t += 1 / FPS) {
    frames.push({ tSec: t, puppetPngBase64: await fakePuppetPng(t), maskPngBase64: await fakeMaskPng() });
  }
  console.log("   frame count:", frames.length);

  console.log("3. running buildContinuousSequence (extracts each original frame + blends with the puppet)...");
  const seqDir = path.join(TMP, "seq");
  let lastProgress = 0;
  const { frameCount, width, height } = await buildContinuousSequence(videoPath, frames, seqDir, (f) => (lastProgress = f));
  assert(frameCount === frames.length, "sequence produced one output frame per input frame");
  assert(width === WIDTH && height === HEIGHT, "sequence frames match the source resolution");
  assert(Math.abs(lastProgress - 1) < 1e-6, "progress callback reached 1.0");

  console.log("4. encoding the sequence to a video segment...");
  const segmentPath = path.join(TMP, "segment.mp4");
  await encodeImageSequence(path.join(seqDir, "frame_%05d.png"), FPS, segmentPath);

  console.log("5. splicing the segment back into the source (assembleContinuousVideo)...");
  const outPath = path.join(TMP, "final.mp4");
  await assembleContinuousVideo({
    originalVideoPath: videoPath,
    continuousSegmentPath: segmentPath,
    startSec: CONTINUOUS_START,
    endSec: CONTINUOUS_END,
    trimStartSec: 0,
    trimEndSec: DURATION,
    metadata,
    outPath,
  });

  console.log("6. verifying the exported file with ffprobe...");
  const { stdout } = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", outPath]);
  const outProbe = JSON.parse(stdout);
  const v = outProbe.streams.find((s) => s.codec_type === "video");
  console.log("    video:", v.width, "x", v.height, v.r_frame_rate, "duration:", outProbe.format.duration);
  assert(Number(v.width) === WIDTH && Number(v.height) === HEIGHT, "final export resolution matches the source");
  assert(Math.abs(Number(outProbe.format.duration) - DURATION) < 0.3, `final export duration stays ~= source duration (${DURATION}s)`);

  console.log("7. verifying the background-lock invariant: untouched region is pixel-identical to the source...");
  const untouchedT = 3.0; // well outside [CONTINUOUS_START, CONTINUOUS_END]
  const srcFramePath = path.join(TMP, "untouched-src.png");
  const outFramePath = path.join(TMP, "untouched-out.png");
  await run("ffmpeg", ["-y", "-i", videoPath, "-ss", String(untouchedT), "-frames:v", "1", srcFramePath]);
  await run("ffmpeg", ["-y", "-i", outPath, "-ss", String(untouchedT), "-frames:v", "1", outFramePath]);
  const srcBuf = await sharp(srcFramePath).raw().toBuffer();
  const outBuf = await sharp(outFramePath).raw().toBuffer();
  const untouchedDiff = meanAbsDiff(srcBuf, outBuf);
  console.log("    mean abs diff at t=" + untouchedT + "s (outside replaced range):", untouchedDiff.toFixed(2));
  assert(untouchedDiff < 2, "frame outside the replaced range is (near-)pixel-identical to the source (re-encoding rounding only)");

  console.log("8. verifying the puppet content actually landed inside the replaced range...");
  const insideT = (CONTINUOUS_START + CONTINUOUS_END) / 2;
  const srcInsidePath = path.join(TMP, "inside-src.png");
  const outInsidePath = path.join(TMP, "inside-out.png");
  await run("ffmpeg", ["-y", "-i", videoPath, "-ss", String(insideT), "-frames:v", "1", srcInsidePath]);
  await run("ffmpeg", ["-y", "-i", outPath, "-ss", String(insideT), "-frames:v", "1", outInsidePath]);
  const srcInsideBuf = await sharp(srcInsidePath).raw().toBuffer();
  const outInsideBuf = await sharp(outInsidePath).raw().toBuffer();
  const insideDiff = meanAbsDiff(srcInsideBuf, outInsideBuf);
  console.log("    mean abs diff at t=" + insideT + "s (inside replaced range):", insideDiff.toFixed(2));
  assert(insideDiff > 10, "frame inside the replaced range visibly differs from the source (the puppet was actually composited)");

  console.log("\nALL CONTINUOUS-MODE PIPELINE CHECKS PASSED. Output:", outPath);
}

/** A solid-color square standing in for the warped puppet image at time t (color varies with t so per-frame identity is checkable if ever needed). */
async function fakePuppetPng(t) {
  const hue = Math.round((t * 137) % 360);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
    <rect width="100%" height="100%" fill="hsl(${hue},70%,50%)" />
  </svg>`;
  return (await sharp(Buffer.from(svg)).png().toBuffer()).toString("base64");
}

/** A centered ellipse mask, same shape used by the other synthetic-mask smoke tests in this repo. */
async function fakeMaskPng() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
    <rect width="100%" height="100%" fill="black" />
    <ellipse cx="${WIDTH * 0.5}" cy="${HEIGHT * 0.5}" rx="${WIDTH * 0.2}" ry="${HEIGHT * 0.45}" fill="white" />
  </svg>`;
  return (await sharp(Buffer.from(svg)).png().toBuffer()).toString("base64");
}

function meanAbsDiff(a, b) {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) sum += Math.abs(a[i] - b[i]);
  return sum / n;
}

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("   ok:", msg);
}

main().catch((err) => {
  console.error("CONTINUOUS-MODE SMOKE TEST FAILED:", err);
  process.exit(1);
});
