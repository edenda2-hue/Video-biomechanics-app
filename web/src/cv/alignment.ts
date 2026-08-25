import type { PoseKeypoint } from "../types";

export interface AffineTransform {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
}

export const IDENTITY_TRANSFORM: AffineTransform = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

export interface FitResult {
  transform: AffineTransform;
  /** How many keypoints the final transform was fit from, after outlier rejection. */
  matchedPoints: number;
  /** How many keypoints had confident detections in both images, before outlier rejection. */
  candidatePoints: number;
  /** Root-mean-square residual, in destination pixels, of the inlier set after fitting. */
  rmsError: number;
}

interface PointPair {
  sx: number;
  sy: number;
  dx: number;
  dy: number;
}

/** Closed-form least-squares similarity fit (Procrustes/Umeyama) over a set of point pairs. Exact for n=2. */
function fitFromPairs(pairs: PointPair[]): AffineTransform | null {
  const n = pairs.length;
  if (n < 2) return null;

  const srcMeanX = pairs.reduce((s, p) => s + p.sx, 0) / n;
  const srcMeanY = pairs.reduce((s, p) => s + p.sy, 0) / n;
  const dstMeanX = pairs.reduce((s, p) => s + p.dx, 0) / n;
  const dstMeanY = pairs.reduce((s, p) => s + p.dy, 0) / n;

  let num = 0;
  let den = 0;
  let srcVar = 0;
  for (const p of pairs) {
    const scx = p.sx - srcMeanX;
    const scy = p.sy - srcMeanY;
    const dcx = p.dx - dstMeanX;
    const dcy = p.dy - dstMeanY;
    num += scx * dcy - scy * dcx;
    den += scx * dcx + scy * dcy;
    srcVar += scx * scx + scy * scy;
  }
  if (srcVar < 1e-6) return null;

  // Rotation+scale matrix [[a, -b], [b, a]] mapping centered src -> centered dst.
  const a = den / srcVar;
  const b = num / srcVar;
  const tx = dstMeanX - (a * srcMeanX - b * srcMeanY);
  const ty = dstMeanY - (b * srcMeanX + a * srcMeanY);

  // Canvas setTransform(a, b, c, d, e, f) maps (x,y) -> (a*x + c*y + e, b*x + d*y + f).
  return { a, b, c: -b, d: a, tx, ty };
}

function pointError(t: AffineTransform, p: PointPair): number {
  const px = t.a * p.sx + t.c * p.sy + t.tx;
  const py = t.b * p.sx + t.d * p.sy + t.ty;
  return Math.hypot(px - p.dx, py - p.dy);
}

function rms(t: AffineTransform, pairs: PointPair[]): number {
  const sq = pairs.reduce((s, p) => s + pointError(t, p) ** 2, 0);
  return Math.sqrt(sq / pairs.length);
}

/**
 * Fits the best 2D similarity transform (uniform scale + rotation +
 * translation, no shear) that maps `srcPose` keypoints onto `dstPose`
 * keypoints, so the uploaded anatomy image lands exactly on the original
 * frame's person.
 *
 * A single bad joint match (common on stylized anatomical figures, which
 * pose detection handles less reliably than real photos) can otherwise
 * skew a plain least-squares fit badly. So this runs RANSAC: every pair of
 * candidate points determines a candidate transform (a similarity
 * transform has exactly 4 degrees of freedom); the candidate with the most
 * inliers wins, and the final transform is refit (least-squares) over just
 * that inlier set.
 */
export function fitSimilarityTransform(
  srcPose: PoseKeypoint[],
  dstPose: PoseKeypoint[],
  srcSize: { width: number; height: number },
  dstSize: { width: number; height: number },
): FitResult {
  const dstByPart = new Map(dstPose.map((k) => [k.part, k]));
  const pairs: PointPair[] = [];
  for (const s of srcPose) {
    const d = dstByPart.get(s.part);
    if (!d || s.confidence < 0.3 || d.confidence < 0.3) continue;
    pairs.push({
      sx: s.x * srcSize.width,
      sy: s.y * srcSize.height,
      dx: d.x * dstSize.width,
      dy: d.y * dstSize.height,
    });
  }

  if (pairs.length < 3) {
    return { transform: IDENTITY_TRANSFORM, matchedPoints: 0, candidatePoints: pairs.length, rmsError: Infinity };
  }

  let inlierSet = pairs;
  if (pairs.length >= 4) {
    const threshold = Math.hypot(dstSize.width, dstSize.height) * 0.04;
    let bestInliers: PointPair[] = [];
    for (let i = 0; i < pairs.length; i++) {
      for (let j = i + 1; j < pairs.length; j++) {
        const candidate = fitFromPairs([pairs[i], pairs[j]]);
        if (!candidate) continue;
        const inliers = pairs.filter((p) => pointError(candidate, p) < threshold);
        if (inliers.length > bestInliers.length) bestInliers = inliers;
      }
    }
    if (bestInliers.length >= 3) inlierSet = bestInliers;
  }

  const transform = fitFromPairs(inlierSet) ?? IDENTITY_TRANSFORM;
  return {
    transform,
    matchedPoints: inlierSet.length,
    candidatePoints: pairs.length,
    rmsError: rms(transform, inlierSet),
  };
}

/** Composes a manual nudge (offset/scale/rotation, applied in destination space) on top of an auto-fit transform. */
export function composeManualAdjustment(
  base: AffineTransform,
  adjust: { offsetX: number; offsetY: number; scale: number; rotationDeg: number },
  pivot: { x: number; y: number },
): AffineTransform {
  const rad = (adjust.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad) * adjust.scale;
  const sin = Math.sin(rad) * adjust.scale;

  // Manual matrix M rotates/scales around `pivot`, then translates by offset.
  const ma = cos;
  const mb = sin;
  const mc = -sin;
  const md = cos;
  const mtx = pivot.x - cos * pivot.x + sin * pivot.y + adjust.offsetX;
  const mty = pivot.y - sin * pivot.x - cos * pivot.y + adjust.offsetY;

  // Compose: result = M * base
  return {
    a: ma * base.a + mc * base.b,
    b: mb * base.a + md * base.b,
    c: ma * base.c + mc * base.d,
    d: mb * base.c + md * base.d,
    tx: ma * base.tx + mc * base.ty + mtx,
    ty: mb * base.tx + md * base.ty + mty,
  };
}

export function warpImageToCanvas(
  image: CanvasImageSource,
  transform: AffineTransform,
  targetWidth: number,
  targetHeight: number,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(transform.a, transform.b, transform.c, transform.d, transform.tx, transform.ty);
  ctx.drawImage(image, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return canvas;
}

/** Vertical [top, bottom] extent of the person in normalized (0-1) frame coordinates, used by the "wipe"/"wipe-reverse" transition styles. */
export function verticalBounds(pose: PoseKeypoint[]): { top: number; bottom: number } {
  const confident = pose.filter((k) => k.confidence >= 0.3);
  const ys = confident.map((k) => k.y);
  if (ys.length === 0) return { top: 0.05, bottom: 0.95 };
  return { top: Math.min(...ys), bottom: Math.max(...ys) };
}

/** Normalized (0-1) center of the person's bounding box, used by the "radial" transition style. Mirrors server/src/lib/compositing.ts's radialCenterFromPose. */
export function boundsCenter(pose: PoseKeypoint[]): { cx: number; cy: number } {
  const confident = pose.filter((k) => k.confidence >= 0.3);
  if (confident.length === 0) return { cx: 0.5, cy: 0.5 };
  const xs = confident.map((k) => k.x);
  const ys = confident.map((k) => k.y);
  return { cx: (Math.min(...xs) + Math.max(...xs)) / 2, cy: (Math.min(...ys) + Math.max(...ys)) / 2 };
}
