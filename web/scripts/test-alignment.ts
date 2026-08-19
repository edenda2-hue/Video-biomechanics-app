// Standalone sanity check for the pose-based alignment math (no DOM/canvas
// needed for these two functions, so this runs directly under tsx/node).
// Run with: npx tsx scripts/test-alignment.ts
import { composeManualAdjustment, fitSimilarityTransform } from "../src/cv/alignment";
import type { BodyPart, PoseKeypoint } from "../src/types";
import { BODY_PARTS } from "../src/types";

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`FAILED: ${msg}`);
    process.exit(1);
  }
  console.log(`ok: ${msg}`);
}

const srcSize = { width: 400, height: 600 };
const dstSize = { width: 800, height: 500 };

// A plausible standing-pose skeleton, normalized 0-1 in `srcSize` space.
const basePose: Record<BodyPart, [number, number]> = {
  head: [0.5, 0.1],
  neck: [0.5, 0.18],
  left_shoulder: [0.4, 0.22],
  right_shoulder: [0.6, 0.22],
  left_elbow: [0.32, 0.38],
  right_elbow: [0.68, 0.38],
  left_wrist: [0.28, 0.5],
  right_wrist: [0.72, 0.5],
  left_hand: [0.27, 0.52],
  right_hand: [0.73, 0.52],
  spine: [0.5, 0.32],
  pelvis: [0.5, 0.48],
  left_hip: [0.44, 0.48],
  right_hip: [0.56, 0.48],
  left_knee: [0.43, 0.68],
  right_knee: [0.57, 0.68],
  left_ankle: [0.42, 0.88],
  right_ankle: [0.58, 0.88],
  left_foot: [0.41, 0.92],
  right_foot: [0.59, 0.92],
};

const srcPose: PoseKeypoint[] = BODY_PARTS.map((part) => ({ part, x: basePose[part][0], y: basePose[part][1], confidence: 0.9 }));

// Ground-truth transform (pixel space): scale 1.4, rotate 12deg, translate (60, -20).
const trueScale = 1.4;
const trueAngle = (12 * Math.PI) / 180;
const trueTx = 60;
const trueTy = -20;
const ta = Math.cos(trueAngle) * trueScale;
const tb = Math.sin(trueAngle) * trueScale;

function applyTrue(px: number, py: number) {
  return { x: ta * px - tb * py + trueTx, y: tb * px + ta * py + trueTy };
}

// Build dstPose by applying the ground-truth transform to srcPose's pixel coords.
const dstPose: PoseKeypoint[] = srcPose.map((k) => {
  const px = k.x * srcSize.width;
  const py = k.y * srcSize.height;
  const p = applyTrue(px, py);
  return { part: k.part, x: p.x / dstSize.width, y: p.y / dstSize.height, confidence: 0.9 };
});

const fit = fitSimilarityTransform(srcPose, dstPose, srcSize, dstSize);
console.log("fit:", fit);

assert(fit.matchedPoints === BODY_PARTS.length, "all keypoints matched");
assert(fit.rmsError < 0.5, `fit error is near-zero for a noiseless synthetic case (got ${fit.rmsError.toFixed(4)}px)`);
assert(Math.abs(fit.transform.a - ta) < 0.01, "recovered scale*cos matches ground truth");
assert(Math.abs(fit.transform.b - tb) < 0.01, "recovered scale*sin matches ground truth");
assert(Math.abs(fit.transform.tx - trueTx) < 1, "recovered tx matches ground truth");
assert(Math.abs(fit.transform.ty - trueTy) < 1, "recovered ty matches ground truth");

// A point at the exact center of dstSize should round-trip through the fitted transform.
const testPt = { x: 123, y: 77 };
const viaFit = { x: fit.transform.a * testPt.x - fit.transform.b * testPt.y + fit.transform.tx, y: fit.transform.b * testPt.x + fit.transform.a * testPt.y + fit.transform.ty };
const viaTrue = applyTrue(testPt.x, testPt.y);
assert(Math.hypot(viaFit.x - viaTrue.x, viaFit.y - viaTrue.y) < 1, "fitted transform matches ground truth on an arbitrary point");

// Too few confident matches should fall back to identity rather than a wild fit.
const sparse = fitSimilarityTransform(srcPose.slice(0, 2), dstPose.slice(0, 2), srcSize, dstSize);
assert(sparse.matchedPoints < 3 && sparse.transform.a === 1 && sparse.transform.tx === 0, "falls back to identity with <3 matches");

// Manual nudge composition: identity base + zero adjustment should stay identity.
const composedNoop = composeManualAdjustment(fit.transform, { offsetX: 0, offsetY: 0, scale: 1, rotationDeg: 0 }, { x: 0, y: 0 });
assert(
  Math.abs(composedNoop.a - fit.transform.a) < 1e-9 && Math.abs(composedNoop.tx - fit.transform.tx) < 1e-9,
  "no-op manual adjustment leaves the auto-fit transform unchanged",
);

// A pure translation nudge should just add to tx/ty around any pivot.
const nudged = composeManualAdjustment(fit.transform, { offsetX: 10, offsetY: -5, scale: 1, rotationDeg: 0 }, { x: 200, y: 200 });
assert(Math.abs(nudged.tx - (fit.transform.tx + 10)) < 1e-6, "translation nudge shifts tx by offsetX");
assert(Math.abs(nudged.ty - (fit.transform.ty - 5)) < 1e-6, "translation nudge shifts ty by offsetY");

console.log("\nALL ALIGNMENT MATH CHECKS PASSED");
