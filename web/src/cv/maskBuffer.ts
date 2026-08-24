// Pure (DOM-free) helpers for working with raw single-channel mask buffers,
// shared by the single-frame segmentation path and the continuous-mode
// per-frame mask tracker. Kept separate from segmentation.ts/videoMaskTrack.ts
// so the resize math is unit-testable under plain Node (no canvas).

function clampIndex(v: number, max: number): number {
  return Math.min(max, Math.max(0, v));
}

export function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/**
 * Bilinear-resamples a `srcW`x`srcH` single-channel float buffer (values
 * typically in [0,1], as MediaPipe's confidence masks are) to `dstW`x`dstH`.
 * Returns a copy (never the same array instance) even when the size is
 * unchanged, so callers can safely mutate the result.
 */
export function resizeMaskBuffer(src: Float32Array, srcW: number, srcH: number, dstW: number, dstH: number): Float32Array {
  if (srcW === dstW && srcH === dstH) return src.slice();
  const dst = new Float32Array(dstW * dstH);
  for (let y = 0; y < dstH; y++) {
    const sy = ((y + 0.5) / dstH) * srcH - 0.5;
    const y0 = Math.floor(sy);
    const fy = sy - y0;
    const cy0 = clampIndex(y0, srcH - 1);
    const cy1 = clampIndex(y0 + 1, srcH - 1);
    for (let x = 0; x < dstW; x++) {
      const sx = ((x + 0.5) / dstW) * srcW - 0.5;
      const x0 = Math.floor(sx);
      const fx = sx - x0;
      const cx0 = clampIndex(x0, srcW - 1);
      const cx1 = clampIndex(x0 + 1, srcW - 1);

      const v00 = src[cy0 * srcW + cx0];
      const v10 = src[cy0 * srcW + cx1];
      const v01 = src[cy1 * srcW + cx0];
      const v11 = src[cy1 * srcW + cx1];
      const top = v00 * (1 - fx) + v10 * fx;
      const bottom = v01 * (1 - fx) + v11 * fx;
      dst[y * dstW + x] = top * (1 - fy) + bottom * fy;
    }
  }
  return dst;
}

/** Renders a raw mask buffer to a grayscale PNG data URL (white=person), matching segmentPerson()'s output format. DOM-dependent (canvas), not unit-tested directly. */
export function maskBufferToPngDataUrl(buf: Float32Array, width: number, height: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const imageData = ctx.createImageData(width, height);
  for (let i = 0; i < buf.length; i++) {
    const v = Math.round(clamp01(buf[i]) * 255);
    imageData.data[i * 4] = v;
    imageData.data[i * 4 + 1] = v;
    imageData.data[i * 4 + 2] = v;
    imageData.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png");
}
