// Places an uploaded anatomy image onto a target frame under full manual
// control. This module used to bend the uploaded image joint-by-joint to
// match the target pose automatically (a "skeletal puppet" warp — see
// limbWarp.ts, still used by continuous mode, which is a different,
// automatic-tracking-across-a-video feature the user hasn't objected to).
// That auto-fit was removed here after direct user feedback: uploading a
// specific image and having the app reshape its content — even with good
// intentions — isn't acceptable for this manual flow. The image you upload
// is exactly the image that gets composited; the app does not alter its
// content in any way.
//
// The only placement the system still provides is a neutral, pose-agnostic
// "center + scale to fit" starting point (the same thing any image viewer
// does when it opens a picture) — it reads no pose data and performs no
// matching. Everything from there — position, size, rotation — is the
// user's own drag/pinch gesture on AnatomyAligner.tsx.
import { composeManualAdjustment, warpImageToCanvas, type AffineTransform } from "./alignment";

export interface ManualAdjust {
  offsetX: number;
  offsetY: number;
  scale: number;
  rotationDeg: number;
}

export const DEFAULT_MANUAL_ADJUST: ManualAdjust = { offsetX: 0, offsetY: 0, scale: 1, rotationDeg: 0 };

/** Pure geometry, no pose data: centers `src` within `dst` at the largest scale that still fits entirely inside it. */
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
 * Renders `rawImage` onto a `targetSize`-sized canvas: centered/scaled to
 * fit as the neutral starting placement, then `manualAdjust`
 * (offset/scale/rotation, entirely user-driven) composed on top around the
 * target frame's center. No pose data is read; the image content is never
 * reshaped, only positioned.
 */
export function placeAnatomyManually(
  rawImage: HTMLImageElement,
  rawSize: { width: number; height: number },
  targetSize: { width: number; height: number },
  manualAdjust: ManualAdjust = DEFAULT_MANUAL_ADJUST,
): HTMLCanvasElement {
  const base = centerFitTransform(rawSize, targetSize);
  const pivot = { x: targetSize.width / 2, y: targetSize.height / 2 };
  const full = composeManualAdjustment(base, manualAdjust, pivot);
  return warpImageToCanvas(rawImage, full, targetSize.width, targetSize.height);
}
