// Skeletal "puppet" warp: the core mechanic for continuous (not single-frame)
// anatomy animation. A single anatomy reference image (already aligned to
// one reference frame, same as the existing single-freeze flow) is cut into
// per-limb regions around each bone; every output frame re-warps each
// region by the rigid transform that carries the reference bone onto that
// frame's tracked bone, then composites the regions back together in a
// fixed z-order. No AI image/video generation is involved after the single
// reference image is produced — cost and latency don't scale with clip
// length.
import type { AffineTransform } from "./alignment";
import type { BodyPart, PoseKeypoint } from "../types";

export interface BoneSegment {
  name: string;
  /** Joint the bone (and its rigid transform) is anchored/rotated around. */
  proximal: BodyPart;
  distal: BodyPart;
  /** Capsule half-width as a fraction of the bone's own length. */
  widthFactor: number;
  /** Extra length added past each end, as a fraction of bone length, so adjacent segments overlap at joints instead of leaving gaps. */
  overlapFactor: number;
  /** Paint order: later entries draw on top. */
  order: number;
}

export const BONE_SEGMENTS: BoneSegment[] = [
  { name: "torso", proximal: "neck", distal: "pelvis", widthFactor: 0.55, overlapFactor: 0.35, order: 0 },
  { name: "head", proximal: "neck", distal: "head", widthFactor: 0.9, overlapFactor: 0.5, order: 5 },
  { name: "left_upper_arm", proximal: "left_shoulder", distal: "left_elbow", widthFactor: 0.32, overlapFactor: 0.3, order: 1 },
  { name: "right_upper_arm", proximal: "right_shoulder", distal: "right_elbow", widthFactor: 0.32, overlapFactor: 0.3, order: 1 },
  { name: "left_forearm", proximal: "left_elbow", distal: "left_wrist", widthFactor: 0.28, overlapFactor: 0.3, order: 2 },
  { name: "right_forearm", proximal: "right_elbow", distal: "right_wrist", widthFactor: 0.28, overlapFactor: 0.3, order: 2 },
  { name: "left_hand", proximal: "left_wrist", distal: "left_hand", widthFactor: 0.5, overlapFactor: 0.4, order: 3 },
  { name: "right_hand", proximal: "right_wrist", distal: "right_hand", widthFactor: 0.5, overlapFactor: 0.4, order: 3 },
  { name: "left_thigh", proximal: "left_hip", distal: "left_knee", widthFactor: 0.34, overlapFactor: 0.3, order: 1 },
  { name: "right_thigh", proximal: "right_hip", distal: "right_knee", widthFactor: 0.34, overlapFactor: 0.3, order: 1 },
  { name: "left_shin", proximal: "left_knee", distal: "left_ankle", widthFactor: 0.28, overlapFactor: 0.3, order: 2 },
  { name: "right_shin", proximal: "right_knee", distal: "right_ankle", widthFactor: 0.28, overlapFactor: 0.3, order: 2 },
  { name: "left_foot", proximal: "left_ankle", distal: "left_foot", widthFactor: 0.4, overlapFactor: 0.5, order: 3 },
  { name: "right_foot", proximal: "right_ankle", distal: "right_foot", widthFactor: 0.4, overlapFactor: 0.5, order: 3 },
];

export interface Point {
  x: number;
  y: number;
}

/**
 * The rigid (translate + rotate + uniform scale) transform that carries the
 * reference bone `refA -> refB` exactly onto the target bone `tgtA -> tgtB`.
 * Anchored so `refA` maps to `tgtA` and the whole reference image rotates/
 * scales around that anchor.
 */
export function boneTransform(refA: Point, refB: Point, tgtA: Point, tgtB: Point): AffineTransform {
  const refDx = refB.x - refA.x;
  const refDy = refB.y - refA.y;
  const refLen = Math.hypot(refDx, refDy);
  const tgtDx = tgtB.x - tgtA.x;
  const tgtDy = tgtB.y - tgtA.y;
  const tgtLen = Math.hypot(tgtDx, tgtDy);

  if (refLen < 1e-6 || tgtLen < 1e-6) {
    return { a: 1, b: 0, c: 0, d: 1, tx: tgtA.x - refA.x, ty: tgtA.y - refA.y };
  }

  const scale = tgtLen / refLen;
  const rot = Math.atan2(tgtDy, tgtDx) - Math.atan2(refDy, refDx);
  const cos = Math.cos(rot) * scale;
  const sin = Math.sin(rot) * scale;

  const a = cos;
  const b = sin;
  const c = -sin;
  const d = cos;
  const tx = tgtA.x - (a * refA.x + c * refA.y);
  const ty = tgtA.y - (b * refA.x + d * refA.y);
  return { a, b, c, d, tx, ty };
}

export function applyTransform(t: AffineTransform, p: Point): Point {
  return { x: t.a * p.x + t.c * p.y + t.tx, y: t.b * p.x + t.d * p.y + t.ty };
}

/**
 * A capsule ("stadium") polygon around a bone segment, in the *reference*
 * image's coordinate space: a rectangle of the given half-width flanked by
 * two rounded end-caps, extended past each joint by `overlapFactor` so
 * neighboring segments overlap rather than leaving a seam at the joint.
 * Pure geometry (no canvas dependency) so it's unit-testable in Node.
 */
export function capsulePolygon(a: Point, b: Point, halfWidth: number, overlap: number, capSteps = 8): Point[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1e-6;
  const ux = dx / len;
  const uy = dy / len;
  // Perpendicular unit vector.
  const px = -uy;
  const py = ux;

  const extA = { x: a.x - ux * overlap, y: a.y - uy * overlap };
  const extB = { x: b.x + ux * overlap, y: b.y + uy * overlap };

  const points: Point[] = [];
  // Straight side from extA+perp to extB+perp.
  points.push({ x: extA.x + px * halfWidth, y: extA.y + py * halfWidth });
  points.push({ x: extB.x + px * halfWidth, y: extB.y + py * halfWidth });
  // Rounded cap around extB.
  const angleAtB = Math.atan2(py, px);
  for (let i = 1; i < capSteps; i++) {
    const t = angleAtB - (Math.PI * i) / capSteps;
    points.push({ x: extB.x + Math.cos(t) * halfWidth, y: extB.y + Math.sin(t) * halfWidth });
  }
  // Straight side back from extB-perp to extA-perp.
  points.push({ x: extB.x - px * halfWidth, y: extB.y - py * halfWidth });
  points.push({ x: extA.x - px * halfWidth, y: extA.y - py * halfWidth });
  // Rounded cap around extA.
  const angleAtA = Math.atan2(-py, -px);
  for (let i = 1; i < capSteps; i++) {
    const t = angleAtA - (Math.PI * i) / capSteps;
    points.push({ x: extA.x + Math.cos(t) * halfWidth, y: extA.y + Math.sin(t) * halfWidth });
  }
  return points;
}

function toPixel(k: PoseKeypoint, size: { width: number; height: number }): Point {
  return { x: k.x * size.width, y: k.y * size.height };
}

/** The bone's orientation angle (radians) within its own pose, or null if either joint isn't confidently detected. Scale/position-invariant — only the direction matters. */
function boneAngle(pose: PoseKeypoint[], seg: BoneSegment, minConfidence = 0.3): number | null {
  const byPart = new Map(pose.map((k) => [k.part, k]));
  const a = byPart.get(seg.proximal);
  const b = byPart.get(seg.distal);
  if (!a || !b || a.confidence < minConfidence || b.confidence < minConfidence) return null;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.hypot(dx, dy) < 1e-6) return null;
  return Math.atan2(dy, dx);
}

/**
 * How different two poses' *articulation* is — i.e. how differently each
 * limb is oriented — independent of where the person is in frame or how
 * big they appear. Used to pick, among several anatomy reference images
 * (each in its own pose), the one whose joint angles are closest to a given
 * exercise frame before warping it, since a single reference image can only
 * be stretched so far from its original pose before the per-limb warp looks
 * wrong (e.g. a standing reference warped toward an overhead lockout).
 * Returns the mean angular difference (radians, 0 = identical articulation)
 * over every bone segment confidently resolved in both poses; `Infinity` if
 * none resolve in both (the two poses share no comparable segment).
 */
export function poseDistance(poseA: PoseKeypoint[], poseB: PoseKeypoint[]): number {
  let sum = 0;
  let count = 0;
  for (const seg of BONE_SEGMENTS) {
    const angleA = boneAngle(poseA, seg);
    const angleB = boneAngle(poseB, seg);
    if (angleA === null || angleB === null) continue;
    let diff = Math.abs(angleA - angleB) % (2 * Math.PI);
    if (diff > Math.PI) diff = 2 * Math.PI - diff;
    sum += diff;
    count++;
  }
  return count > 0 ? sum / count : Infinity;
}

/** Index of the reference pose in `references` whose articulation is closest to `targetPose` (see poseDistance). */
export function nearestPoseIndex(targetPose: PoseKeypoint[], references: PoseKeypoint[][]): number {
  let bestIndex = 0;
  let bestDist = Infinity;
  for (let i = 0; i < references.length; i++) {
    const d = poseDistance(targetPose, references[i]);
    if (d < bestDist) {
      bestDist = d;
      bestIndex = i;
    }
  }
  return bestIndex;
}

/**
 * Per-segment rigid transforms (reference anatomy image pixel space ->
 * target frame pixel space) for every bone segment whose four endpoints
 * (both joints, in both poses) are confidently detected. Segments that
 * can't be resolved are omitted; the caller should hold the previous
 * frame's transform for those rather than let the limb disappear.
 */
export function computeSegmentTransforms(
  refPose: PoseKeypoint[],
  tgtPose: PoseKeypoint[],
  refSize: { width: number; height: number },
  tgtSize: { width: number; height: number },
  minConfidence = 0.3,
): Map<string, AffineTransform> {
  const refByPart = new Map(refPose.map((k) => [k.part, k]));
  const tgtByPart = new Map(tgtPose.map((k) => [k.part, k]));
  const out = new Map<string, AffineTransform>();

  for (const seg of BONE_SEGMENTS) {
    const rA = refByPart.get(seg.proximal);
    const rB = refByPart.get(seg.distal);
    const tA = tgtByPart.get(seg.proximal);
    const tB = tgtByPart.get(seg.distal);
    if (!rA || !rB || !tA || !tB) continue;
    if (rA.confidence < minConfidence || rB.confidence < minConfidence) continue;
    if (tA.confidence < minConfidence || tB.confidence < minConfidence) continue;

    const transform = boneTransform(toPixel(rA, refSize), toPixel(rB, refSize), toPixel(tA, tgtSize), toPixel(tB, tgtSize));
    out.set(seg.name, transform);
  }
  return out;
}

/**
 * Renders one continuous-mode output frame: warps every resolvable bone
 * segment of the reference anatomy image onto `targetSize` by its own rigid
 * transform (`computeSegmentTransforms`), clipped to that segment's capsule
 * region (`capsulePolygon`, computed in the reference image's own
 * coordinates from `refPose`), painted in `BONE_SEGMENTS` order (torso
 * first, then limbs, extremities and head last) so overlaps at joints look
 * layered rather than torn. A segment whose four endpoints aren't all
 * confidently detected is simply skipped for that frame.
 */
export function renderSkeletalPuppetFrameFromPoses(
  refImage: CanvasImageSource,
  refPose: PoseKeypoint[],
  tgtPose: PoseKeypoint[],
  refSize: { width: number; height: number },
  targetSize: { width: number; height: number },
  minConfidence = 0.3,
): HTMLCanvasElement {
  const refByPart = new Map(refPose.map((k) => [k.part, k]));
  const transforms = computeSegmentTransforms(refPose, tgtPose, refSize, targetSize, minConfidence);

  const canvas = document.createElement("canvas");
  canvas.width = targetSize.width;
  canvas.height = targetSize.height;
  const ctx = canvas.getContext("2d")!;

  const ordered = [...BONE_SEGMENTS].sort((x, y) => x.order - y.order);
  for (const seg of ordered) {
    const t = transforms.get(seg.name);
    if (!t) continue;
    const rA = refByPart.get(seg.proximal);
    const rB = refByPart.get(seg.distal);
    if (!rA || !rB) continue;
    const a = toPixel(rA, refSize);
    const b = toPixel(rB, refSize);
    const boneLen = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const poly = capsulePolygon(a, b, boneLen * seg.widthFactor, boneLen * seg.overlapFactor);

    ctx.save();
    ctx.setTransform(t.a, t.b, t.c, t.d, t.tx, t.ty);
    ctx.beginPath();
    ctx.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(refImage, 0, 0, refSize.width, refSize.height);
    ctx.restore();
  }
  return canvas;
}
