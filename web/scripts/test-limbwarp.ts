// Standalone sanity check for the skeletal-puppet warp math (pure geometry,
// no DOM/canvas needed for these functions, so this runs directly under
// tsx/node). Run with: npx tsx scripts/test-limbwarp.ts
import { applyTransform, boneTransform, capsulePolygon, computeSegmentTransforms, nearestPoseIndex, poseDistance } from "../src/cv/limbWarp";
import type { BodyPart, PoseKeypoint } from "../src/types";

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`FAILED: ${msg}`);
    process.exit(1);
  }
  console.log(`ok: ${msg}`);
}

function close(a: number, b: number, eps = 1e-6) {
  return Math.abs(a - b) < eps;
}

// --- boneTransform: exact recovery of a known rotation+scale+translation ---
{
  const refA = { x: 100, y: 100 };
  const refB = { x: 100, y: 200 }; // straight down, length 100

  // Target bone: rotated 90deg (now points right), scaled 1.5x, translated.
  const tgtA = { x: 300, y: 50 };
  const tgtB = { x: 450, y: 50 }; // length 150, pointing right (+x)

  const t = boneTransform(refA, refB, tgtA, tgtB);
  const mappedA = applyTransform(t, refA);
  const mappedB = applyTransform(t, refB);
  assert(close(mappedA.x, tgtA.x) && close(mappedA.y, tgtA.y), "boneTransform maps the proximal joint exactly onto the target");
  assert(close(mappedB.x, tgtB.x) && close(mappedB.y, tgtB.y), "boneTransform maps the distal joint exactly onto the target");

  // A midpoint of the bone should land at the corresponding midpoint too (rigid transform, no shear).
  const refMid = { x: (refA.x + refB.x) / 2, y: (refA.y + refB.y) / 2 };
  const tgtMid = { x: (tgtA.x + tgtB.x) / 2, y: (tgtA.y + tgtB.y) / 2 };
  const mappedMid = applyTransform(t, refMid);
  assert(close(mappedMid.x, tgtMid.x) && close(mappedMid.y, tgtMid.y), "boneTransform maps the bone midpoint onto the target midpoint");
}

// --- boneTransform: pure elbow bend (rotation only, same length) preserves scale = 1 ---
{
  const shoulderRef = { x: 0, y: 0 };
  const elbowRef = { x: 0, y: 50 }; // upper arm hanging straight down

  const shoulderTgt = { x: 0, y: 0 };
  const elbowTgt = { x: 50 * Math.cos(Math.PI / 4), y: 50 * Math.sin(Math.PI / 4) }; // rotated 45deg, same length

  const t = boneTransform(shoulderRef, elbowRef, shoulderTgt, elbowTgt);
  const scale = Math.hypot(t.a, t.b); // scale factor embedded in the rotation+scale block
  assert(close(scale, 1, 1e-6), "a pure rotation (same bone length) yields unit scale");
  const mapped = applyTransform(t, elbowRef);
  assert(close(mapped.x, elbowTgt.x) && close(mapped.y, elbowTgt.y), "elbow bend maps the distal joint to the rotated target position");
}

// --- capsulePolygon: every vertex stays within halfWidth+overlap of the bone segment's bounding region ---
{
  const a = { x: 0, y: 0 };
  const b = { x: 0, y: 100 };
  const halfWidth = 20;
  const overlap = 15;
  const poly = capsulePolygon(a, b, halfWidth, overlap);
  assert(poly.length > 4, "capsulePolygon produces a rounded (multi-vertex) polygon, not just a 4-point rectangle");
  // Rounded end-caps are half-disks of radius halfWidth centered on the overlap-extended endpoints,
  // so the polygon's true bounding box extends halfWidth further past each extended end, not just overlap.
  const maxReach = overlap + halfWidth;
  for (const p of poly) {
    assert(p.x >= -halfWidth - 1e-6 && p.x <= halfWidth + 1e-6, `capsule vertex x=${p.x.toFixed(2)} stays within the bone's half-width`);
    assert(p.y >= -maxReach - 1e-6 && p.y <= 100 + maxReach + 1e-6, `capsule vertex y=${p.y.toFixed(2)} stays within the capsule's true reach (overlap + cap radius)`);
  }
}

// --- computeSegmentTransforms: full pose pair resolves every defined bone segment ---
{
  const srcSize = { width: 400, height: 600 };
  const dstSize = { width: 800, height: 500 };
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
    spine: [0.5, 0.35],
    pelvis: [0.5, 0.5],
    left_hip: [0.42, 0.5],
    right_hip: [0.58, 0.5],
    left_knee: [0.4, 0.68],
    right_knee: [0.6, 0.68],
    left_ankle: [0.38, 0.86],
    right_ankle: [0.62, 0.86],
    left_foot: [0.37, 0.9],
    right_foot: [0.63, 0.9],
  };
  const toPose = (record: Record<BodyPart, [number, number]>, confidence = 0.9): PoseKeypoint[] =>
    Object.entries(record).map(([part, [x, y]]) => ({ part: part as BodyPart, x, y, confidence }));

  const refPose = toPose(basePose);
  // A "squatted" target pose: knees/hips lower and bent, arms raised — a plausible mid-rep frame.
  const squatPose = toPose({
    ...basePose,
    left_knee: [0.36, 0.6],
    right_knee: [0.64, 0.6],
    left_hip: [0.42, 0.58],
    right_hip: [0.58, 0.58],
    left_ankle: [0.38, 0.82],
    right_ankle: [0.62, 0.82],
    left_wrist: [0.2, 0.3],
    right_wrist: [0.8, 0.3],
  });

  const transforms = computeSegmentTransforms(refPose, squatPose, srcSize, dstSize);
  assert(transforms.size === 14, `every bone segment resolves when all joints are confident (got ${transforms.size}/14)`);

  const thigh = transforms.get("left_thigh")!;
  const hipRef = { x: basePose.left_hip[0] * srcSize.width, y: basePose.left_hip[1] * srcSize.height };
  const mappedHip = applyTransform(thigh, hipRef);
  const expectedHipTgt = { x: 0.42 * dstSize.width, y: 0.58 * dstSize.height };
  assert(close(mappedHip.x, expectedHipTgt.x, 1e-3) && close(mappedHip.y, expectedHipTgt.y, 1e-3), "left_thigh transform maps the hip joint onto the squat target's hip position");
}

// --- computeSegmentTransforms: a low-confidence joint drops that segment, not the whole pose ---
{
  const size = { width: 400, height: 600 };
  const parts: BodyPart[] = [
    "head", "neck", "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
    "left_wrist", "right_wrist", "left_hand", "right_hand", "spine", "pelvis",
    "left_hip", "right_hip", "left_knee", "right_knee", "left_ankle", "right_ankle",
    "left_foot", "right_foot",
  ];
  const makePose = (lowConfidencePart: BodyPart): PoseKeypoint[] =>
    parts.map((part, i) => ({ part, x: 0.4 + i * 0.01, y: 0.1 + i * 0.04, confidence: part === lowConfidencePart ? 0.1 : 0.9 }));

  const refPose = makePose("left_knee");
  const tgtPose = makePose("left_knee");
  const transforms = computeSegmentTransforms(refPose, tgtPose, size, size);
  assert(!transforms.has("left_thigh"), "a low-confidence knee joint drops the left_thigh segment");
  assert(!transforms.has("left_shin"), "a low-confidence knee joint drops the left_shin segment");
  assert(transforms.has("right_thigh") && transforms.has("torso"), "unrelated segments still resolve when only one joint is low-confidence");
}

// --- poseDistance / nearestPoseIndex: multi-reference pose matching ---
{
  const standing: PoseKeypoint[] = [
    { part: "head", x: 0.5, y: 0.1, confidence: 0.9 },
    { part: "neck", x: 0.5, y: 0.18, confidence: 0.9 },
    { part: "left_shoulder", x: 0.42, y: 0.2, confidence: 0.9 },
    { part: "right_shoulder", x: 0.58, y: 0.2, confidence: 0.9 },
    { part: "left_elbow", x: 0.4, y: 0.35, confidence: 0.9 }, // arm hanging straight down
    { part: "right_elbow", x: 0.6, y: 0.35, confidence: 0.9 },
    { part: "left_wrist", x: 0.38, y: 0.5, confidence: 0.9 },
    { part: "right_wrist", x: 0.62, y: 0.5, confidence: 0.9 },
    { part: "left_hip", x: 0.45, y: 0.5, confidence: 0.9 },
    { part: "right_hip", x: 0.55, y: 0.5, confidence: 0.9 },
    { part: "left_knee", x: 0.45, y: 0.7, confidence: 0.9 }, // leg straight down
    { part: "right_knee", x: 0.55, y: 0.7, confidence: 0.9 },
    { part: "left_ankle", x: 0.45, y: 0.9, confidence: 0.9 },
    { part: "right_ankle", x: 0.55, y: 0.9, confidence: 0.9 },
  ];
  // Overhead lockout: arms straight up instead of down (a ~180deg change at the shoulder).
  const overhead: PoseKeypoint[] = standing.map((k) => {
    if (k.part === "left_elbow") return { ...k, y: 0.05 };
    if (k.part === "right_elbow") return { ...k, y: 0.05 };
    if (k.part === "left_wrist") return { ...k, y: -0.1 };
    if (k.part === "right_wrist") return { ...k, y: -0.1 };
    return k;
  });
  // A near-identical standing pose, just scaled 1.4x and shifted — should read as "close" despite different scale/position.
  const standingScaled: PoseKeypoint[] = standing.map((k) => ({ ...k, x: k.x * 1.4 + 0.3, y: k.y * 1.4 + 0.1 }));
  // A standing pose with only the knees bent slightly (much smaller articulation change than the overhead swing).
  const slightBend: PoseKeypoint[] = standing.map((k) => {
    if (k.part === "left_knee") return { ...k, x: k.x + 0.02, y: k.y - 0.03 };
    if (k.part === "right_knee") return { ...k, x: k.x - 0.02, y: k.y - 0.03 };
    return k;
  });

  assert(poseDistance(standing, standing) < 1e-9, "poseDistance is ~0 for a pose compared to itself");
  assert(poseDistance(standing, standingScaled) < 1e-6, "poseDistance is scale/position-invariant");
  const distToOverhead = poseDistance(standing, overhead);
  const distToSlightBend = poseDistance(standing, slightBend);
  assert(distToOverhead > distToSlightBend, "an overhead-arms pose reads as further from standing than a slight knee bend does");
  assert(distToOverhead > 0.5, "a ~180deg arm swing produces a large pose distance");

  const nearest = nearestPoseIndex(slightBend, [overhead, standing, standingScaled]);
  assert(nearest === 1, `nearestPoseIndex picks the standing reference (closest articulation) for a slight-bend query, got index ${nearest}`);
}

console.log("\nAll limb-warp checks passed.");
