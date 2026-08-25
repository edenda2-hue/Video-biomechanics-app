import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { LabelPlacement, PoseKeypoint } from "../types.js";

function smoothstep(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

/**
 * Yields to the Node event loop. The per-pixel blend loops below are pure
 * synchronous JS with no natural `await` point, so on a real (not tiny
 * test-fixture) frame resolution a single blend call can block the event
 * loop for long enough that other in-flight requests — notably the
 * export-status poll the UI depends on — get starved and the platform's
 * proxy (e.g. Render's) can return a 502 for them even though the job
 * itself is still running fine server-side. Yielding periodically keeps
 * the server responsive to those requests throughout compositing.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
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
  /** Anatomy Keyframes mode: when set, zeroes the mask around the head (see excludeHeadFromMask) so the real head/face always shows through, only the body swaps to anatomy. */
  excludeHeadPose?: PoseKeypoint[];
}

/**
 * Zeroes a circular region of a raw greyscale mask buffer around the head,
 * in place, so downstream compositing (`m = maskBuf[p]/255 * alpha`) always
 * leaves that area as the literal original pixels regardless of anatomy
 * content — "Anatomy Keyframes" mode swaps the body but keeps the person's
 * real head showing. Falls back to a fraction of the frame height when the
 * neck isn't confidently detected (no head-to-neck distance to size the
 * circle from); no-ops entirely if the head itself isn't confidently
 * detected. Mutates and returns the same buffer (not a copy) — callers
 * that need the original mask preserved should pass in a copy.
 */
export function excludeHeadFromMask<T extends Uint8Array>(maskBuf: T, width: number, height: number, pose: PoseKeypoint[]): T {
  const head = pose.find((k) => k.part === "head" && k.confidence >= 0.3);
  if (!head) return maskBuf;
  const neck = pose.find((k) => k.part === "neck" && k.confidence >= 0.3);

  const cx = head.x * width;
  const cy = head.y * height;
  const radius = neck
    ? Math.hypot((neck.x - head.x) * width, (neck.y - head.y) * height) * 1.4
    : height * 0.09;

  const rSq = radius * radius;
  const minY = Math.max(0, Math.floor(cy - radius));
  const maxY = Math.min(height - 1, Math.ceil(cy + radius));
  const minX = Math.max(0, Math.floor(cx - radius));
  const maxX = Math.min(width - 1, Math.ceil(cx + radius));
  for (let y = minY; y <= maxY; y++) {
    const dy = y - cy;
    const rowStart = y * width;
    for (let x = minX; x <= maxX; x++) {
      const dx = x - cx;
      if (dx * dx + dy * dy <= rSq) maskBuf[rowStart + x] = 0;
    }
  }
  return maskBuf;
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
  let maskBuf = await sharp(maskPath).resize(width, height).greyscale().raw().toBuffer(); // 1 channel, 0-255
  if (opts.excludeHeadPose) maskBuf = excludeHeadFromMask(maskBuf, width, height, opts.excludeHeadPose);

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
          ? await blendFrameWipe(originalBuf, anatomyBuf, maskBuf, width, height, bounds, spec.phase, spec.t)
          : await blendFrame(
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
 * A head-to-foot "wipe" reveal: a soft gradient band sweeps from the top of
 * the person (`bounds.top`) to the bottom (`bounds.bottom`) as `t` goes
 * 0->1. In phase "in", rows above the band become anatomy (the figure
 * "puts itself on" from the head down); in phase "out" the same sweep
 * direction instead reveals the original body again. The sweep overshoots
 * half a feather band on each side so it reaches full coverage/clearance
 * exactly at t=1, matching the flat alpha=1 hold phase with no visible pop.
 *
 * The feather band is deliberately wide (most of the body's own height, not
 * a thin line) so the gradient spans close to the whole figure at any given
 * moment: at t=0.5 the torso is already mostly anatomy while the legs are
 * only just beginning, rather than a hard boundary where everything above
 * some row is 100% anatomy and everything below is 100% bare skin. A
 * narrower feather (~12% of the body's height, the original value) reads as
 * a line sweeping down the body with a harsh edge, and was flagged directly
 * from a real export: mid-transition frames showed the torso fully "dressed"
 * while an entire leg was still untouched original footage. Widening it is
 * a pure tuning change — the same math already guarantees exact 0%/100%
 * coverage at t=0/t=1 for any feather width, since the sweep always
 * overshoots by half the feather on each side.
 */
async function blendFrameWipe(
  originalBuf: Buffer,
  anatomyBuf: Buffer,
  maskBuf: Buffer,
  width: number,
  height: number,
  bounds: { top: number; bottom: number },
  phase: "in" | "out",
  t: number,
): Promise<Buffer> {
  const span = Math.max(1e-3, bounds.bottom - bounds.top);
  const feather = span * 0.65;
  const threshold = bounds.top - feather / 2 + t * (span + feather);

  // Only the per-pixel *alpha* is computed in JS (one cheap multiply per
  // pixel); the actual RGB blending is done by compositeOver() using
  // sharp/libvips' native "over" compositing, which runs on libvips' own
  // worker thread pool rather than Node's main JS thread — see
  // compositeOver()'s doc comment for why that matters here.
  const anatomyWithAlpha = Buffer.from(anatomyBuf);
  const ROWS_PER_CHUNK = 64;
  for (let y = 0; y < height; y++) {
    const ny = y / height;
    const local = (threshold - ny) / feather + 0.5;
    const covered = smoothstep(local); // 1 = swept over (anatomy side), 0 = not yet (original side)
    const rowAlpha = phase === "in" ? covered : 1 - covered;
    const rowStart = y * width;
    for (let x = 0; x < width; x++) {
      const p = rowStart + x;
      anatomyWithAlpha[p * 4 + 3] = Math.round(maskBuf[p] * rowAlpha);
    }
    if (y % ROWS_PER_CHUNK === ROWS_PER_CHUNK - 1) await yieldToEventLoop();
  }
  return compositeOver(originalBuf, anatomyWithAlpha, width, height);
}

/** result = original * (1 - mask*alpha) + anatomy * (mask*alpha), computed via native alpha compositing. */
export async function blendFrame(
  originalBuf: Buffer,
  anatomyBuf: Buffer,
  maskBuf: Buffer,
  alpha: number,
  width: number,
  height: number,
): Promise<Buffer> {
  const anatomyWithAlpha = Buffer.from(anatomyBuf);
  const total = width * height;
  const PIXELS_PER_CHUNK = 500_000;
  for (let p = 0; p < total; p++) {
    anatomyWithAlpha[p * 4 + 3] = Math.round(maskBuf[p] * alpha);
    if (p % PIXELS_PER_CHUNK === PIXELS_PER_CHUNK - 1) await yieldToEventLoop();
  }
  return compositeOver(originalBuf, anatomyWithAlpha, width, height);
}

/**
 * Composites `topWithAlpha` (RGBA, its alpha channel already set to
 * exactly the per-pixel blend weight the caller wants) over `baseBuf`,
 * via sharp/libvips' native Porter-Duff "over" operator — which is
 * precisely `result = base*(1-a) + top*a`, the same formula this file
 * used to compute by hand in a JS loop. The earlier hand-rolled version
 * blocked Node's single-threaded event loop for the entire blend (all
 * three RGB channels, every pixel) with no way to truly run concurrently
 * with anything else; libvips does this work on its own native thread
 * pool, so the Node event loop — and the export-status poll requests the
 * UI depends on — stay responsive throughout, not just "yield often
 * enough that blocking is hopefully short."
 */
async function compositeOver(baseBuf: Buffer, topWithAlpha: Buffer, width: number, height: number): Promise<Buffer> {
  return sharp(baseBuf, { raw: { width, height, channels: 4 } })
    .composite([{ input: topWithAlpha, raw: { width, height, channels: 4 }, blend: "over" }])
    .raw()
    .toBuffer();
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
