import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { LabelPlacement, PoseKeypoint, TransitionStyle } from "../types.js";

type SweepStyle = Exclude<TransitionStyle, "dissolve">;

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

/** Normalized [top, bottom] vertical extent of the person, for the "wipe"/"wipe-reverse" sweep geometry. */
export function verticalBoundsFromPose(pose: PoseKeypoint[]): { top: number; bottom: number } {
  const ys = pose.filter((k) => k.confidence >= 0.3).map((k) => k.y);
  if (ys.length === 0) return { top: 0.05, bottom: 0.95 };
  return { top: Math.min(...ys), bottom: Math.max(...ys) };
}

/** Normalized [0,1] center of the person's bounding box, for the "radial" sweep style ("anatomy grows from within"). */
export function radialCenterFromPose(pose: PoseKeypoint[]): { cx: number; cy: number } {
  const confident = pose.filter((k) => k.confidence >= 0.3);
  if (confident.length === 0) return { cx: 0.5, cy: 0.5 };
  const xs = confident.map((k) => k.x);
  const ys = confident.map((k) => k.y);
  return { cx: (Math.min(...xs) + Math.max(...xs)) / 2, cy: (Math.min(...ys) + Math.max(...ys)) / 2 };
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
  /** See TransitionStyle in ../types.ts. Defaults to "wipe". */
  style?: TransitionStyle;
  /** Normalized [0,1] vertical extent of the person; used by "wipe"/"wipe-reverse". */
  verticalBounds?: { top: number; bottom: number };
  /** Normalized [0,1] center of the person; used by "radial". */
  radialCenter?: { cx: number; cy: number };
  /** Anatomy Keyframes mode: when set, zeroes the mask around the head (see excludeHeadFromMask) so the real head/face always shows through, only the body swaps to anatomy. */
  excludeHeadPose?: PoseKeypoint[];
  /**
   * Opt-in per-keyframe/frame override: skip the real segmentation mask
   * entirely and treat every pixel as confidently "person" (i.e. show
   * exactly what the user manually placed, unchanged), instead of letting
   * the mask's own confidence silently carve out regions the user already
   * positioned by hand. `excludeHeadPose` still applies on top, so the head
   * is still excluded as always — this only overrides the *body* mask.
   */
  ignoreMask?: boolean;
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
  // ignoreMask: treat every pixel as confidently "person" instead of
  // reading the real mask, so a user's manual placement can't be silently
  // overridden by the segmentation model's own confidence at export time.
  let maskBuf = opts.ignoreMask
    ? Buffer.alloc(width * height, 255)
    : await sharp(maskPath).resize(width, height).greyscale().raw().toBuffer(); // 1 channel, 0-255
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
  const center = opts.radialCenter ?? { cx: 0.5, cy: 0.5 };
  const isSweepStyle = style !== "dissolve";

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
        spec.phase !== "hold" && isSweepStyle
          ? await blendFrameSweep(originalBuf, anatomyBuf, maskBuf, width, height, style, bounds, center, spec.phase, spec.t)
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
 * Deterministic, fast 2D pixel hash -> [0,1). Used by the "pixel-dissolve"
 * sweep style so each pixel's reveal moment is a fixed pseudo-random value:
 * recomputing the same formula from (x,y) every frame — rather than
 * caching a random table — is what keeps it stable across every frame of
 * one transition instead of flickering like TV static.
 */
function pixelHash01(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967295;
}

/**
 * Four spatial reveal orders sharing one smoothstep-threshold-with-feathering
 * core: a per-pixel scalar "metric" is compared against a threshold that
 * sweeps from `metricMin - feather/2` to `metricMax + feather/2` as `t` goes
 * 0->1, so every style reaches exact 0%/100% coverage at t=0/t=1 regardless
 * of feather width (the sweep always overshoots by half the feather on each
 * side) — matching the flat alpha=1 hold phase with no visible pop.
 *
 * - "wipe": metric = normalized y (top-to-bottom, head-first).
 * - "wipe-reverse": metric = 1 - normalized y (bottom-to-top, feet-first).
 * - "radial": metric = pixel distance from the body's center, so the
 *   anatomy grows outward from the torso rather than sweeping in one
 *   direction (an "emerging from within" look) — the max radius reaches
 *   the frame's farthest corner from that center, guaranteeing full-canvas
 *   coverage by t=1 the same way the directional styles guarantee it edge
 *   to edge.
 * - "pixel-dissolve": metric = a fixed per-pixel hash, so individual pixels
 *   across the *whole* body materialize in a spatially-random but
 *   time-stable order — no directional sweep, more of a "coming into focus
 *   everywhere at once" look. Its feather is close to the full metric range
 *   so coverage grows roughly as a uniform fraction of pixels over time
 *   rather than following any particular radius/line.
 *
 * A wide feather (most of the metric's own range, not a thin line/ring) is
 * what makes "wipe" in particular read as the whole figure materializing
 * together with a head-first bias rather than a hard-edged line sweeping
 * down the body — a real export showed the torso already fully "dressed"
 * while an entire leg was still untouched footage before this was widened.
 */
async function blendFrameSweep(
  originalBuf: Buffer,
  anatomyBuf: Buffer,
  maskBuf: Buffer,
  width: number,
  height: number,
  style: SweepStyle,
  bounds: { top: number; bottom: number },
  center: { cx: number; cy: number },
  phase: "in" | "out",
  t: number,
): Promise<Buffer> {
  const cxPx = center.cx * width;
  const cyPx = center.cy * height;

  let metricMin: number;
  let metricMax: number;
  let featherRatio: number;
  if (style === "wipe") {
    metricMin = bounds.top;
    metricMax = bounds.bottom;
    featherRatio = 0.65;
  } else if (style === "wipe-reverse") {
    metricMin = 1 - bounds.bottom;
    metricMax = 1 - bounds.top;
    featherRatio = 0.65;
  } else if (style === "radial") {
    metricMin = 0;
    metricMax = Math.max(
      1e-3,
      Math.max(
        Math.hypot(cxPx, cyPx),
        Math.hypot(cxPx - width, cyPx),
        Math.hypot(cxPx, cyPx - height),
        Math.hypot(cxPx - width, cyPx - height),
      ),
    );
    featherRatio = 0.55;
  } else {
    metricMin = 0;
    metricMax = 1;
    featherRatio = 0.9;
  }

  const span = Math.max(1e-3, metricMax - metricMin);
  const feather = span * featherRatio;
  const threshold = metricMin - feather / 2 + t * (span + feather);

  // Only the per-pixel *alpha* is computed in JS (one cheap multiply per
  // pixel); the actual RGB blending is done by compositeOver() using
  // sharp/libvips' native "over" compositing, which runs on libvips' own
  // worker thread pool rather than Node's main JS thread — see
  // compositeOver()'s doc comment for why that matters here.
  const anatomyWithAlpha = Buffer.from(anatomyBuf);
  const ROWS_PER_CHUNK = 32;
  for (let y = 0; y < height; y++) {
    const wipeMetric = y / height;
    const rowStart = y * width;
    for (let x = 0; x < width; x++) {
      const p = rowStart + x;
      const metric =
        style === "wipe"
          ? wipeMetric
          : style === "wipe-reverse"
            ? 1 - wipeMetric
            : style === "radial"
              ? Math.hypot(x - cxPx, y - cyPx)
              : pixelHash01(x, y);
      const local = (threshold - metric) / feather + 0.5;
      const covered = smoothstep(local); // 1 = swept over (anatomy side), 0 = not yet (original side)
      const alpha = phase === "in" ? covered : 1 - covered;
      // Factor in the anatomy image's OWN alpha (255 = opaque, 0 =
      // transparent) — see blendFrame's doc comment for why this can't be
      // dropped: it's what makes a gap in the user's manual placement fall
      // back to the real footage instead of showing garbage/black.
      anatomyWithAlpha[p * 4 + 3] = Math.round((maskBuf[p] * alpha * anatomyBuf[p * 4 + 3]) / 255);
    }
    if (y % ROWS_PER_CHUNK === ROWS_PER_CHUNK - 1) await yieldToEventLoop();
  }
  return compositeOver(originalBuf, anatomyWithAlpha, width, height);
}

/**
 * result = original * (1 - mask*alpha*anatomyAlpha) + anatomy * (mask*alpha*anatomyAlpha),
 * computed via native alpha compositing. Multiplying in the anatomy
 * buffer's own alpha (not just overwriting it with mask*alpha) matters as
 * soon as the anatomy image isn't fully opaque everywhere the mask says
 * "person" — which is now the normal case for the manual touch-alignment
 * flow (AnatomyAligner.tsx): the uploaded PNG is only opaque where the user
 * actually placed it and transparent everywhere else on the canvas. Without
 * this, any part of the mask silhouette outside that placement rendered as
 * literal black (the canvas's default transparent-pixel RGB) blended in at
 * full weight instead of falling back to the real original footage — caught
 * directly via scripts/compositing-alpha-smoke.mjs, which was previously
 * unable to catch it since keyframes-smoke.mjs's fixture anatomy image is
 * always fully opaque (no gap for the bug to manifest in).
 */
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
    anatomyWithAlpha[p * 4 + 3] = Math.round((maskBuf[p] * alpha * anatomyBuf[p * 4 + 3]) / 255);
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
