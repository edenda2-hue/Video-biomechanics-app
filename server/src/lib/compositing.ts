import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { LabelPlacement, PoseKeypoint } from "../types.js";

function smoothstep(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

/** Normalized [top, bottom] vertical extent of the person, for the wipe transition's sweep geometry. */
export function verticalBoundsFromPose(pose: PoseKeypoint[]): { top: number; bottom: number } {
  const ys = pose.filter((k) => k.confidence >= 0.3).map((k) => k.y);
  if (ys.length === 0) return { top: 0.05, bottom: 0.95 };
  return { top: Math.min(...ys), bottom: Math.max(...ys) };
}

export interface FreezeSequenceOptions {
  originalFramePath: string;
  maskPath: string;
  anatomyImagePath: string;
  fps: number;
  transitionInSec: number;
  holdSec: number;
  transitionOutSec: number;
  outDir: string;
  /** "wipe" sweeps head-to-foot (the anatomy "puts itself on"); "dissolve" is a uniform crossfade. */
  style?: "wipe" | "dissolve";
  /** Normalized [0,1] vertical extent of the person, required for "wipe". */
  verticalBounds?: { top: number; bottom: number };
}

/**
 * Renders the frame-by-frame "body-only" transition: pixels outside the
 * person mask are always the literal original frame bytes; only pixels
 * inside the mask interpolate between the original human and the
 * anatomical figure. This is the mechanical implementation of spec rule
 * #9/#12 ("only the human body transforms; camera, background, equipment,
 * lighting never move or change").
 */
export async function buildFreezeSequence(
  opts: FreezeSequenceOptions,
  onProgress?: (fraction: number) => void,
): Promise<{ frameCount: number; width: number; height: number }> {
  const { originalFramePath, maskPath, anatomyImagePath, fps, transitionInSec, holdSec, transitionOutSec, outDir } = opts;
  const style = opts.style ?? "wipe";
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

  type FrameSpec = { phase: "in" | "hold" | "out"; t: number };
  const specs: FrameSpec[] = [];
  for (let i = 0; i < inFrames; i++) specs.push({ phase: "in", t: i / (inFrames - 1 || 1) });
  for (let i = 0; i < holdFrames; i++) specs.push({ phase: "hold", t: 1 });
  for (let i = 0; i < outFrames; i++) specs.push({ phase: "out", t: i / (outFrames - 1 || 1) });

  const bounds = opts.verticalBounds ?? { top: 0.05, bottom: 0.95 };

  let index = 0;
  let holdFramePath: string | null = null;
  for (const spec of specs) {
    const outPath = path.join(outDir, `frame_${String(index).padStart(5, "0")}.png`);

    // Every "hold" frame is pixel-identical (alpha=1 everywhere); render it
    // once and copy the file for the rest instead of re-running the blend
    // and PNG encode per frame — a hold of several seconds is otherwise a
    // lot of redundant work on a slow/shared CPU.
    if (spec.phase === "hold" && holdFramePath) {
      await fs.copyFile(holdFramePath, outPath);
    } else {
      const frame =
        spec.phase !== "hold" && style === "wipe"
          ? blendFrameWipe(originalBuf, anatomyBuf, maskBuf, width, height, bounds, spec.phase, spec.t)
          : blendFrame(
              originalBuf,
              anatomyBuf,
              maskBuf,
              spec.phase === "in" ? smoothstep(spec.t) : spec.phase === "out" ? 1 - smoothstep(spec.t) : 1,
              width,
              height,
            );
      await sharp(frame, { raw: { width, height, channels: 4 } }).png().toFile(outPath);
      if (spec.phase === "hold") holdFramePath = outPath;
    }

    index++;
    onProgress?.(index / specs.length);
  }

  return { frameCount: specs.length, width, height };
}

/**
 * A head-to-foot "wipe" reveal: a horizontal line sweeps from the top of
 * the person (`bounds.top`) to the bottom (`bounds.bottom`) as `t` goes
 * 0->1. In phase "in", rows above the line become anatomy (the figure
 * "puts itself on" from the head down); in phase "out" the same sweep
 * direction instead reveals the original body again. The sweep overshoots
 * half a feather band on each side so it reaches full coverage/clearance
 * exactly at t=1, matching the flat alpha=1 hold phase with no visible pop.
 */
function blendFrameWipe(
  originalBuf: Buffer,
  anatomyBuf: Buffer,
  maskBuf: Buffer,
  width: number,
  height: number,
  bounds: { top: number; bottom: number },
  phase: "in" | "out",
  t: number,
): Buffer {
  const span = Math.max(1e-3, bounds.bottom - bounds.top);
  const feather = span * 0.12;
  const threshold = bounds.top - feather / 2 + t * (span + feather);

  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const ny = y / height;
    const local = (threshold - ny) / feather + 0.5;
    const covered = smoothstep(local); // 1 = swept over (anatomy side), 0 = not yet (original side)
    const rowAlpha = phase === "in" ? covered : 1 - covered;
    const rowStart = y * width;
    for (let x = 0; x < width; x++) {
      const p = rowStart + x;
      const m = (maskBuf[p] / 255) * rowAlpha;
      const o = p * 4;
      for (let c = 0; c < 3; c++) {
        out[o + c] = Math.round(originalBuf[o + c] * (1 - m) + anatomyBuf[o + c] * m);
      }
      out[o + 3] = 255;
    }
  }
  return out;
}

/** result = original * (1 - mask*alpha) + anatomy * (mask*alpha), computed per-pixel in raw RGBA space. */
export function blendFrame(
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
