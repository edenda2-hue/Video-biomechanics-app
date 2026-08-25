// Shared "fit one anatomy image onto one target pose" logic, used by both
// the single-freeze Edit screen and Anatomy Keyframes mode (every keyframe
// runs this same fit independently, against its own frame's pose). Prefers
// the per-limb skeletal-puppet warp (limbWarp.ts) whenever at least
// PUPPET_MIN_SEGMENTS of the 14 bone segments resolve confidently between
// the anatomy image and the target pose — that's what lets a *generic*
// anatomy image bend to match whatever pose the target frame shows, not
// just be uniformly scaled/rotated/positioned onto it. A hand or foot
// keypoint is very commonly the one that fails (gripping a barbell, inside
// a shoe against similar-colored ground) even when every other joint
// resolves fine, so requiring literally all 14 threw away a near-perfect
// puppet fit for one occluded extremity; any segment that doesn't resolve
// is instead filled in from a whole-image rigid fit underneath the puppet
// layer, so a missing hand/foot degrades gracefully to "slightly less
// precise there" instead of "no per-limb warp anywhere in the image."
// Falls back to a pure rigid whole-image fit (or a centered scale-to-fit)
// only when segment detection is too sparse for the puppet to read as a
// coherent body at all.
const PUPPET_MIN_SEGMENTS = 7; // ~half of BONE_SEGMENTS.length (14)
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
  | { mode: "puppet"; matched: number; total: number; gapsFilled: boolean }
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
    if (segments.size >= PUPPET_MIN_SEGMENTS) {
      const puppetCanvas = renderSkeletalPuppetFrameFromPoses(rawImage, rawPose, targetPose, rawSize, targetSize);
      const gapsFilled = segments.size < BONE_SEGMENTS.length;
      if (gapsFilled) {
        // Missing segments (most often a hand or foot) are left fully
        // transparent by the puppet renderer; fill them from a whole-image
        // rigid fit underneath rather than showing a hole or discarding the
        // (otherwise good) per-limb warp for every other segment.
        const fit = fitSimilarityTransform(rawPose, targetPose, rawSize, targetSize);
        const composed = document.createElement("canvas");
        composed.width = targetSize.width;
        composed.height = targetSize.height;
        const cctx = composed.getContext("2d")!;
        if (fit.matchedPoints >= 3) {
          cctx.drawImage(warpImageToCanvas(rawImage, fit.transform, targetSize.width, targetSize.height), 0, 0);
        }
        cctx.drawImage(puppetCanvas, 0, 0);
        baseCanvas = composed;
      } else {
        baseCanvas = puppetCanvas;
      }
      info = { mode: "puppet", matched: segments.size, total: BONE_SEGMENTS.length, gapsFilled };
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
