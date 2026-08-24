// Continuous mode's server-side compositing pass: unlike the single-freeze
// flow (one shared original frame + one shared anatomy image, blended at a
// varying alpha for the transition), here every output frame has its own
// original frame *and* its own already-warped puppet image (rendered
// client-side by web/src/cv/limbWarp.ts from that frame's tracked pose) and
// its own mask (web/src/cv/videoMaskTrack.ts). This module's job is just to
// re-extract each original frame directly from the source video (never
// trusting a client-supplied background, so the body-only guarantee stays
// server-enforced) and blend it with the client-supplied puppet+mask using
// the same blendFrame() the single-freeze flow already uses, with alpha
// fixed at 1 (continuous mode has no transition — the puppet is always
// fully "on" for the whole range).
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { blendFrame } from "./compositing.js";
import { extractFrame } from "./ffmpeg.js";

export interface ContinuousFrameInput {
  /** Timestamp within the source video this frame corresponds to. */
  tSec: number;
  /** Already-warped anatomy puppet for this frame, as a PNG data URL or base64 (RGBA, any size — resized to the source frame's resolution). */
  puppetPngBase64: string;
  /** Person/background mask for this frame, as a PNG data URL or base64 (greyscale, any size — resized to match). */
  maskPngBase64: string;
}

/**
 * Builds the continuous-mode frame sequence: for each entry in `frames`
 * (assumed sorted by `tSec`, one per output frame), extracts that exact
 * timestamp from the source video and blends it with the supplied puppet
 * image through the mask, writing `frame_00000.png`, `frame_00001.png`, ...
 * to `outDir` (ready for `encodeImageSequence`).
 */
export async function buildContinuousSequence(
  originalVideoPath: string,
  frames: ContinuousFrameInput[],
  outDir: string,
  onProgress?: (fraction: number) => void,
): Promise<{ frameCount: number; width: number; height: number }> {
  if (frames.length === 0) throw new Error("buildContinuousSequence requires at least one frame");
  await fs.mkdir(outDir, { recursive: true });

  let width = 0;
  let height = 0;
  let index = 0;
  for (const f of frames) {
    const origPath = path.join(outDir, `_orig_${index}.png`);
    await extractFrame(originalVideoPath, f.tSec, origPath);

    const meta = await sharp(origPath).metadata();
    if (!meta.width || !meta.height) throw new Error(`Could not read dimensions for frame at t=${f.tSec}`);
    width = meta.width;
    height = meta.height;

    const originalBuf = await sharp(origPath).ensureAlpha().raw().toBuffer();
    const puppetBuf = await sharp(toBuffer(f.puppetPngBase64))
      .resize(width, height)
      .ensureAlpha()
      .raw()
      .toBuffer();
    const maskBuf = await sharp(toBuffer(f.maskPngBase64)).resize(width, height).greyscale().raw().toBuffer();

    const blended = await blendFrame(originalBuf, puppetBuf, maskBuf, 1, width, height);
    const outPath = path.join(outDir, `frame_${String(index).padStart(5, "0")}.png`);
    await sharp(blended, { raw: { width, height, channels: 4 } }).png().toFile(outPath);
    await fs.unlink(origPath);

    index++;
    onProgress?.(index / frames.length);
  }

  return { frameCount: frames.length, width, height };
}

function toBuffer(pngBase64OrDataUrl: string): Buffer {
  const comma = pngBase64OrDataUrl.indexOf(",");
  const raw = pngBase64OrDataUrl.startsWith("data:") && comma >= 0 ? pngBase64OrDataUrl.slice(comma + 1) : pngBase64OrDataUrl;
  return Buffer.from(raw, "base64");
}
