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
  matchedPoints: number;
  /** Root-mean-square residual, in destination pixels, after fitting. */
  rmsError: number;
}

/**
 * Fits the best 2D similarity transform (uniform scale + rotation +
 * translation, no shear) that maps `srcPose` keypoints onto `dstPose`
 * keypoints, via least-squares (closed-form Procrustes/Umeyama solution —
 * no iterative solver needed for this DOF count).
 *
 * Used to align a manually-created anatomical image onto the exact
 * coordinate space of the original video frame: pose estimation runs on
 * both images, and this computes how to move/scale/rotate the uploaded
 * image so its joints land on top of the original person's joints.
 */
export function fitSimilarityTransform(
  srcPose: PoseKeypoint[],
  dstPose: PoseKeypoint[],
  srcSize: { width: number; height: number },
  dstSize: { width: number; height: number },
): FitResult {
  const dstByPart = new Map(dstPose.map((k) => [k.part, k]));
  const pairs: { sx: number; sy: number; dx: number; dy: number }[] = [];
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
    return { transform: IDENTITY_TRANSFORM, matchedPoints: pairs.length, rmsError: Infinity };
  }

  const n = pairs.length;
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

  if (srcVar < 1e-6) {
    return { transform: IDENTITY_TRANSFORM, matchedPoints: pairs.length, rmsError: Infinity };
  }

  // Rotation+scale matrix [[a, -b], [b, a]] mapping centered src -> centered dst.
  const a = den / srcVar;
  const b = num / srcVar;
  const tx = dstMeanX - (a * srcMeanX - b * srcMeanY);
  const ty = dstMeanY - (b * srcMeanX + a * srcMeanY);

  // Canvas setTransform(a, b, c, d, e, f) maps (x,y) -> (a*x + c*y + e, b*x + d*y + f).
  const transform: AffineTransform = { a, b, c: -b, d: a, tx, ty };

  let sqErr = 0;
  for (const p of pairs) {
    const px = a * p.sx - b * p.sy + tx;
    const py = b * p.sx + a * p.sy + ty;
    sqErr += (px - p.dx) ** 2 + (py - p.dy) ** 2;
  }

  return { transform, matchedPoints: pairs.length, rmsError: Math.sqrt(sqErr / n) };
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
  image: HTMLImageElement,
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

/** Vertical [top, bottom] extent of the person in normalized (0-1) frame coordinates, used by the wipe transition. */
export function verticalBounds(pose: PoseKeypoint[]): { top: number; bottom: number } {
  const confident = pose.filter((k) => k.confidence >= 0.3);
  const ys = confident.map((k) => k.y);
  if (ys.length === 0) return { top: 0.05, bottom: 0.95 };
  return { top: Math.min(...ys), bottom: Math.max(...ys) };
}
