import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { LabelPlacement } from "../types.js";

function smoothstep(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

export interface FreezeSequenceOptions {
  originalFramePath: string;
  maskPath: string;
  anatomyImagePath: string; // final anatomy frame (highlight + labels already baked in)
  fps: number;
  transitionInSec: number;
  holdSec: number;
  transitionOutSec: number;
  outDir: string;
}

/**
 * Renders the frame-by-frame "body-only" transition: pixels outside the
 * person mask are always the literal original frame bytes; only pixels
 * inside the mask interpolate between the original human and the
 * anatomical figure. This is the mechanical implementation of spec rule
 * #9/#12 ("only the human body transforms; camera, background, equipment,
 * lighting never move or change").
 */
export async function buildFreezeSequence(opts: FreezeSequenceOptions): Promise<{ frameCount: number; width: number; height: number }> {
  const { originalFramePath, maskPath, anatomyImagePath, fps, transitionInSec, holdSec, transitionOutSec, outDir } = opts;
  await fs.mkdir(outDir, { recursive: true });

  const original = sharp(originalFramePath);
  const { width, height } = await original.metadata();
  if (!width || !height) throw new Error("Could not read frame dimensions");

  const originalBuf = await sharp(originalFramePath).ensureAlpha().raw().toBuffer();
  const anatomyBuf = await sharp(anatomyImagePath).resize(width, height).ensureAlpha().raw().toBuffer();
  const maskBuf = await sharp(maskPath).resize(width, height).greyscale().raw().toBuffer(); // 1 channel, 0-255

  const inFrames = Math.max(1, Math.round(fps * transitionInSec));
  const holdFrames = Math.max(1, Math.round(fps * holdSec));
  const outFrames = Math.max(1, Math.round(fps * transitionOutSec));

  const alphas: number[] = [];
  for (let i = 0; i < inFrames; i++) alphas.push(smoothstep(i / (inFrames - 1 || 1)));
  for (let i = 0; i < holdFrames; i++) alphas.push(1);
  for (let i = 0; i < outFrames; i++) alphas.push(1 - smoothstep(i / (outFrames - 1 || 1)));

  let index = 0;
  for (const alpha of alphas) {
    const frame = blendFrame(originalBuf, anatomyBuf, maskBuf, alpha, width, height);
    const outPath = path.join(outDir, `frame_${String(index).padStart(5, "0")}.png`);
    await sharp(frame, { raw: { width, height, channels: 4 } }).png().toFile(outPath);
    index++;
  }

  return { frameCount: alphas.length, width, height };
}

/** result = original * (1 - mask*alpha) + anatomy * (mask*alpha), computed per-pixel in raw RGBA space. */
function blendFrame(
  originalBuf: Buffer,
  anatomyBuf: Buffer,
  maskBuf: Buffer,
  alpha: number,
  width: number,
  height: number,
): Buffer {
  const out = Buffer.alloc(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const m = (maskBuf[p] / 255) * alpha;
    const o = p * 4;
    for (let c = 0; c < 3; c++) {
      out[o + c] = Math.round(originalBuf[o + c] * (1 - m) + anatomyBuf[o + c] * m);
    }
    out[o + 3] = 255;
  }
  return out;
}

/** Bakes leader-line + muscle-name overlays onto an anatomy image as real pixels (used for the frozen hold + transitions). */
export async function bakeLabels(imagePath: string, labels: LabelPlacement[], outPath: string) {
  const { width, height } = await sharp(imagePath).metadata();
  if (!width || !height) throw new Error("Could not read image dimensions");

  const lines = labels
    .map((l) => {
      const points = l.leaderPath.map((p) => `${(p.x * width).toFixed(1)},${(p.y * height).toFixed(1)}`).join(" ");
      const lx = l.labelPos.x * width;
      const ly = l.labelPos.y * height;
      const anchorX = l.anchor.x * width;
      const anchorY = l.anchor.y * height;
      // Labels sit in a margin column near the left or right canvas edge
      // (see labelLayout.ts); anchor text so it grows inward, never off-canvas.
      const textAnchor = l.labelPos.x < 0.5 ? "start" : "end";
      return `
        <polyline points="${points}" fill="none" stroke="#f2f2f2" stroke-width="1.5" stroke-linecap="round" />
        <circle cx="${anchorX.toFixed(1)}" cy="${anchorY.toFixed(1)}" r="3" fill="#8b0000" stroke="#f2f2f2" stroke-width="1" />
        <text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" font-family="Arial, sans-serif" font-size="${Math.max(12, width * 0.014).toFixed(0)}"
          font-weight="600" fill="#f2f2f2" text-anchor="${textAnchor}"
          stroke="#000000" stroke-width="3" paint-order="stroke fill">${escapeXml(l.name.toUpperCase())}</text>
      `;
    })
    .join("\n");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${lines}</svg>`;

  await sharp(imagePath)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toFile(outPath);
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Simple RGBA diff outside the mask, used by the quality gate's background-consistency score. */
export async function backgroundDiffScore(originalFramePath: string, candidatePath: string, maskPath: string): Promise<number> {
  const meta = await sharp(originalFramePath).metadata();
  const width = meta.width!;
  const height = meta.height!;

  const a = await sharp(originalFramePath).ensureAlpha().raw().toBuffer();
  const b = await sharp(candidatePath).resize(width, height).ensureAlpha().raw().toBuffer();
  const mask = await sharp(maskPath).resize(width, height).greyscale().raw().toBuffer();

  let diffSum = 0;
  let bgPixels = 0;
  for (let p = 0; p < width * height; p++) {
    const isBackground = mask[p] < 32; // only score pixels clearly outside the person mask
    if (!isBackground) continue;
    bgPixels++;
    const o = p * 4;
    const d = Math.abs(a[o] - b[o]) + Math.abs(a[o + 1] - b[o + 1]) + Math.abs(a[o + 2] - b[o + 2]);
    diffSum += d / (255 * 3);
  }
  if (bgPixels === 0) return 1;
  const meanDiff = diffSum / bgPixels;
  return Math.max(0, 1 - meanDiff);
}
