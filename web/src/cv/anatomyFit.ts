// Shared "fit one anatomy image onto one target pose" logic, used by both
// the single-freeze Edit screen and Anatomy Keyframes mode (every keyframe
// runs this same fit independently, against its own frame's pose). Prefers
// the per-limb skeletal-puppet warp (limbWarp.ts) whenever every one of the
// 14 bone segments resolves confidently between the anatomy image and the
// target pose — that's what lets a *generic* anatomy image bend to match
// whatever pose the target frame shows, not just be uniformly scaled/
// rotated/positioned onto it. Falls back to a rigid whole-image fit (or a
// centered scale-to-fit) when segment detection is incomplete, since a
// partial puppet would leave visible gaps where unresolved limbs simply
// aren't drawn.
import {
  composeManualAdjustment,
  fitSimilarityTransform,
  warpImageToCanvas,
  IDENTITY_TRANSFORM,
  type AffineTransform,
} from "./alignment";
import { BONE_SEGMENTS, computeSegmentTransforms, renderSkeletalPuppetFrameFromPoses } from "./limbWarp";
import type { PoseKeypoint } from "../types";

export type AnatomyFitInfo =
  | { mode: "puppet"; matched: number; total: number }
  | { mode: "rigid"; matched: number; total: number }
  | { mode: "center" };

export interface AnatomyFitResult {
  canvas: HTMLCanvasElement;
  info: AnatomyFitInfo;
}

export interface ManualAdjust {
  offsetX: number;
  offsetY: number;
  scale: number;
  rotationDeg: number;
}

export const DEFAULT_MANUAL_ADJUST: ManualAdjust = { offsetX: 0, offsetY: 0, scale: 1, rotationDeg: 0 };

export function centerFitTransform(src: { width: number; height: number }, dst: { width: number; height: number }): AffineTransform {
  const scale = Math.min(dst.width / src.width, dst.height / src.height);
  return {
    a: scale,
    b: 0,
    c: 0,
    d: scale,
    tx: (dst.width - src.width * scale) / 2,
    ty: (dst.height - src.height * scale) / 2,
  };
}

/**
 * Fits `rawImage` (with its own detected `rawPose`, in its own `rawSize`
 * pixel space) onto `targetPose`/`targetSize`, then applies `manualAdjust`
 * as a final whole-canvas nudge on top. Returns the composited canvas plus
 * which fit strategy was actually used, for UI feedback.
 */
export function fitAnatomyToPose(
  rawImage: HTMLImageElement,
  rawPose: PoseKeypoint[],
  rawSize: { width: number; height: number },
  targetPose: PoseKeypoint[],
  targetSize: { width: number; height: number },
  manualAdjust: ManualAdjust = DEFAULT_MANUAL_ADJUST,
): AnatomyFitResult {
  let baseCanvas: HTMLCanvasElement | HTMLImageElement = rawImage;
  let info: AnatomyFitInfo;

  if (rawPose.length > 0) {
    const segments = computeSegmentTransforms(rawPose, targetPose, rawSize, targetSize);
    if (segments.size === BONE_SEGMENTS.length) {
      baseCanvas = renderSkeletalPuppetFrameFromPoses(rawImage, rawPose, targetPose, rawSize, targetSize);
      info = { mode: "puppet", matched: segments.size, total: BONE_SEGMENTS.length };
    } else {
      const fit = fitSimilarityTransform(rawPose, targetPose, rawSize, targetSize);
      const t = fit.matchedPoints >= 3 ? fit.transform : centerFitTransform(rawSize, targetSize);
      baseCanvas = warpImageToCanvas(rawImage, t, targetSize.width, targetSize.height);
      info =
        fit.matchedPoints >= 3
          ? { mode: "rigid", matched: fit.matchedPoints, total: fit.candidatePoints }
          : { mode: "center" };
    }
  } else {
    baseCanvas = warpImageToCanvas(rawImage, centerFitTransform(rawSize, targetSize), targetSize.width, targetSize.height);
    info = { mode: "center" };
  }

  const pivot = { x: targetSize.width / 2, y: targetSize.height / 2 };
  const nudgeTransform = composeManualAdjustment(IDENTITY_TRANSFORM, manualAdjust, pivot);
  const canvas = warpImageToCanvas(baseCanvas, nudgeTransform, targetSize.width, targetSize.height);
  return { canvas, info };
}
