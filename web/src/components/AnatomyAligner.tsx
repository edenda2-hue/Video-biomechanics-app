import { useEffect, useMemo, useRef, useState, type PointerEvent, type WheelEvent } from "react";
import { composeManualAdjustment } from "../cv/alignment";
import { centerFitTransform, DEFAULT_MANUAL_ADJUST, type ManualAdjust, type SplitManualAdjust } from "../cv/anatomyFit";

const DEFAULT_SPLIT_Y = 0.5;

const MAX_DISPLAY_WIDTH = 720;
const MIN_SCALE = 0.2;
const MAX_SCALE = 4;

interface PointerPt {
  x: number;
  y: number;
}

interface GestureState {
  mode: "pan" | "pinch";
  startAdjust: ManualAdjust;
  startMid: PointerPt;
  startDist: number;
  startAngle: number;
}

export interface AnatomyAlignerProps {
  frameImg: HTMLImageElement;
  frameSize: { width: number; height: number };
  /** The raw uploaded anatomy image, unmodified — the app never reshapes or re-renders its content, only positions it. */
  anatomyImg: HTMLImageElement;
  anatomySize: { width: number; height: number };
  initialAdjust: ManualAdjust;
  onConfirm: (adjust: ManualAdjust) => void;
  onCancel: () => void;
  /** The frame's own person-segmentation mask (greyscale, same native size as frameSize), if available — traced into a target-boundary outline over the frame so the alignment is a "fit inside the line" task instead of eyeballing it. Optional: the aligner still works without it. */
  maskImg?: HTMLImageElement;
  /**
   * Reopens the aligner already in split mode with prior state, if this
   * keyframe/frame was last confirmed split. When absent, the aligner opens
   * in normal (single, whole-image) mode.
   */
  initialSplit?: SplitManualAdjust | null;
  /**
   * Called instead of `onConfirm` when the user confirms while in split
   * mode (upper/lower body positioned independently — see anatomyFit.ts's
   * `placeAnatomyManuallySplit` doc comment for why this exists: a single
   * rigid placement can't fix a bend-angle mismatch between the anatomy
   * image's own pose and the target frame's).
   */
  onConfirmSplit?: (split: SplitManualAdjust) => void;
}

/**
 * Reads a greyscale person mask down to a flat per-pixel array (one byte per
 * pixel, from the mask's R channel — masks are greyscale so R=G=B) at the
 * aligner's display resolution. Shared by the target-boundary outline and
 * the live coverage-gating below, so the mask image is only ever decoded
 * once per (mask, display size), not on every drag frame.
 */
function readMaskGray(maskImg: HTMLImageElement, width: number, height: number): Uint8Array {
  const src = document.createElement("canvas");
  src.width = width;
  src.height = height;
  const sctx = src.getContext("2d")!;
  sctx.drawImage(maskImg, 0, 0, width, height);
  const data = sctx.getImageData(0, 0, width, height).data;
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) gray[i] = data[i * 4];
  return gray;
}

/**
 * Traces a greyscale person mask into a thin colored outline (the mask's
 * own silhouette edge — where confidence crosses ~50%), at the aligner's
 * display resolution. This is the visual "target boundary" the user aligns
 * the anatomy image against, turning positioning from "eyeball it against
 * the photo" into "fit inside the line" — closer to a matching-game/sticker
 * task than free-form guessing.
 */
function buildMaskOutline(gray: Uint8Array, width: number, height: number): HTMLCanvasElement {
  const THRESHOLD = 128;
  const inside = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) inside[i] = gray[i] >= THRESHOLD ? 1 : 0;

  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const octx = out.getContext("2d")!;
  const outData = octx.createImageData(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!inside[i]) continue;
      const rightOut = x + 1 >= width || !inside[i + 1];
      const leftOut = x - 1 < 0 || !inside[i - 1];
      const downOut = y + 1 >= height || !inside[i + width];
      const upOut = y - 1 < 0 || !inside[i - width];
      if (!(rightOut || leftOut || downOut || upOut)) continue;
      // A 1px-wide edge is hard to see at typical display sizes — thicken by
      // also marking the immediate neighbors of every boundary pixel.
      for (const [dx, dy] of [
        [0, 0],
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const o = (ny * width + nx) * 4;
        outData.data[o] = 255;
        outData.data[o + 1] = 210;
        outData.data[o + 2] = 0;
        outData.data[o + 3] = 255;
      }
    }
  }
  octx.putImageData(outData, 0, 0);
  return out;
}

/** Cuts `img` into upper/lower halves at `splitY` (the image's own pixel space) — each transparent outside its own half. Mirrors anatomyFit.ts's splitImageHalves (kept private there); duplicated here at display resolution since the aligner also needs a live preview of the split, not just the final export composite. */
function buildSplitHalves(img: HTMLImageElement, splitY: number): { upper: HTMLCanvasElement; lower: HTMLCanvasElement } {
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  const cutPx = Math.round(height * splitY);
  function half(y0: number, y1: number): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    ctx.globalCompositeOperation = "destination-in";
    ctx.fillRect(0, y0, width, y1 - y0);
    ctx.globalCompositeOperation = "source-over";
    return canvas;
  }
  return { upper: half(0, cutPx), lower: half(cutPx, height) };
}

/**
 * Multiplies `canvas`'s existing per-pixel alpha by the mask's confidence at
 * that same pixel (gray/255) — the identical rule the server's real export
 * compositing applies (server/src/lib/compositing.ts's blendFrame). Without
 * this, the preview only ever shows a global "see-through" opacity, which
 * looks like full coverage anywhere the anatomy image itself is opaque —
 * even where the mask doesn't confidently classify that spot as body (e.g.
 * a self-occluded armpit next to a bent arm) and export will correctly fall
 * back to the original footage there. Mutates `canvas` in place.
 */
function applyMaskGate(canvas: HTMLCanvasElement, gray: Uint8Array) {
  const ctx = canvas.getContext("2d")!;
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  for (let i = 0; i < gray.length; i++) {
    const a = data[i * 4 + 3];
    if (a === 0) continue;
    data[i * 4 + 3] = Math.round((a * gray[i]) / 255);
  }
  ctx.putImageData(imageData, 0, 0);
}

function dist(a: PointerPt, b: PointerPt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
function angleOf(a: PointerPt, b: PointerPt): number {
  return Math.atan2(b.y - a.y, b.x - a.x);
}
function midpoint(a: PointerPt, b: PointerPt): PointerPt {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Large, touch-first alignment surface: the user drags (one finger) and
 * pinches (two fingers — scale and rotate together) the raw, unmodified
 * anatomy image directly onto the real frame underneath it, instead of
 * describing the correction through small numeric sliders or trusting an
 * algorithm to reshape it automatically. The app never alters the uploaded
 * image's content — the only thing it computes is a neutral, pose-agnostic
 * "center + scale to fit" starting placement (`centerFitTransform`, pure
 * geometry, no pose data), which the user's own gestures then take over
 * from completely.
 */
export default function AnatomyAligner({
  frameImg,
  frameSize,
  anatomyImg,
  anatomySize,
  initialAdjust,
  onConfirm,
  onCancel,
  maskImg,
  initialSplit,
  onConfirmSplit,
}: AnatomyAlignerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [adjust, setAdjust] = useState<ManualAdjust>(initialAdjust);
  const [splitMode, setSplitMode] = useState(Boolean(initialSplit));
  const [splitY, setSplitY] = useState(initialSplit?.splitY ?? DEFAULT_SPLIT_Y);
  const [activeRegion, setActiveRegion] = useState<"upper" | "lower">("upper");
  const [upperAdjust, setUpperAdjust] = useState<ManualAdjust>(initialSplit?.upper ?? initialAdjust);
  const [lowerAdjust, setLowerAdjust] = useState<ManualAdjust>(initialSplit?.lower ?? initialAdjust);
  const [opacity, setOpacity] = useState(0.65);
  const [showTarget, setShowTarget] = useState(true);
  const pointersRef = useRef<Map<number, PointerPt>>(new Map());
  const gestureRef = useRef<GestureState | null>(null);
  const maskScratchRef = useRef<HTMLCanvasElement | null>(null);

  const displayW = Math.min(MAX_DISPLAY_WIDTH, frameSize.width);
  const displayH = Math.round(displayW * (frameSize.height / frameSize.width));
  const displayScale = displayW / frameSize.width;
  const pivotX = frameSize.width / 2;
  const pivotY = frameSize.height / 2;
  const baseTransform = centerFitTransform(anatomySize, frameSize);

  // The adjust the current gesture reads/writes — the single whole-image
  // one in normal mode, or whichever half is "active" in split mode.
  function getCurrentAdjust(): ManualAdjust {
    if (!splitMode) return adjust;
    return activeRegion === "upper" ? upperAdjust : lowerAdjust;
  }
  function setCurrentAdjust(next: ManualAdjust) {
    if (!splitMode) {
      setAdjust(next);
    } else if (activeRegion === "upper") {
      setUpperAdjust(next);
    } else {
      setLowerAdjust(next);
    }
  }

  function toggleSplitMode(next: boolean) {
    setSplitMode(next);
    if (next) {
      // Start both halves from wherever the single placement currently is,
      // so turning split mode on doesn't visually jump.
      setUpperAdjust(adjust);
      setLowerAdjust(adjust);
    }
  }

  // The mask image is decoded to a flat grey array once per (mask, display
  // size) — not on every drag frame — and reused both for the target-outline
  // trace and for gating the live anatomy-layer preview below.
  const maskGray = useMemo(() => (maskImg ? readMaskGray(maskImg, displayW, displayH) : null), [maskImg, displayW, displayH]);
  const outlineCanvas = useMemo(() => (maskGray ? buildMaskOutline(maskGray, displayW, displayH) : null), [maskGray, displayW, displayH]);
  const splitHalves = useMemo(() => (splitMode ? buildSplitHalves(anatomyImg, splitY) : null), [splitMode, anatomyImg, splitY]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(frameImg, 0, 0, displayW, displayH);

    function drawLayer(layer: CanvasImageSource, layerAdjust: ManualAdjust, layerOpacity: number) {
      const full = composeManualAdjustment(baseTransform, layerAdjust, { x: pivotX, y: pivotY });

      // Render the transformed layer onto a scratch canvas first, so its
      // alpha can be gated by the real mask before it ever reaches the
      // visible canvas — matching exactly what the server's export
      // compositing does, instead of the old flat "see-through" opacity
      // that made any opaque anatomy pixel look like guaranteed coverage.
      let scratch = maskScratchRef.current;
      if (!scratch) {
        scratch = document.createElement("canvas");
        maskScratchRef.current = scratch;
      }
      scratch.width = displayW;
      scratch.height = displayH;
      const sctx = scratch.getContext("2d")!;
      sctx.save();
      sctx.setTransform(
        full.a * displayScale,
        full.b * displayScale,
        full.c * displayScale,
        full.d * displayScale,
        full.tx * displayScale,
        full.ty * displayScale,
      );
      sctx.drawImage(layer, 0, 0);
      sctx.restore();

      if (maskGray) {
        applyMaskGate(scratch, maskGray);
      }

      ctx.save();
      ctx.globalAlpha = layerOpacity;
      ctx.drawImage(scratch, 0, 0);
      ctx.restore();
    }

    if (!splitMode) {
      drawLayer(anatomyImg, adjust, opacity);
    } else if (splitHalves) {
      // The inactive half is dimmed further so it's always visually clear
      // which region the current gesture will move.
      drawLayer(splitHalves.upper, upperAdjust, activeRegion === "upper" ? opacity : opacity * 0.5);
      drawLayer(splitHalves.lower, lowerAdjust, activeRegion === "lower" ? opacity : opacity * 0.5);
    }

    // Drawn last, always at full opacity, independent of the see-through
    // slider above — a fixed target boundary to fit the anatomy layer
    // inside, like a matching-game outline, rather than a preview layer.
    if (showTarget && outlineCanvas) {
      ctx.drawImage(outlineCanvas, 0, 0);
    }
  }, [
    adjust,
    splitMode,
    splitHalves,
    upperAdjust,
    lowerAdjust,
    activeRegion,
    opacity,
    showTarget,
    frameImg,
    anatomyImg,
    baseTransform,
    outlineCanvas,
    maskGray,
    displayW,
    displayH,
    displayScale,
    pivotX,
    pivotY,
  ]);

  function canvasPoint(e: PointerEvent<HTMLCanvasElement>): PointerPt {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height),
    };
  }

  function resetGesture(current: ManualAdjust) {
    const pts = Array.from(pointersRef.current.values());
    if (pts.length === 1) {
      gestureRef.current = { mode: "pan", startAdjust: current, startMid: pts[0], startDist: 0, startAngle: 0 };
    } else if (pts.length === 2) {
      gestureRef.current = {
        mode: "pinch",
        startAdjust: current,
        startMid: midpoint(pts[0], pts[1]),
        startDist: dist(pts[0], pts[1]),
        startAngle: angleOf(pts[0], pts[1]),
      };
    } else {
      gestureRef.current = null;
    }
  }

  function handlePointerDown(e: PointerEvent<HTMLCanvasElement>) {
    // Capture keeps move/up events targeting this canvas even if the finger
    // drags outside its bounds — a UX nicety, not load-bearing for the
    // tracking logic below, which only reads from pointersRef. Some pointer
    // sources (and, in practice, synthetic non-hardware pointers) reject
    // capture with InvalidPointerId; that's not worth losing the gesture over.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore — see comment above
    }
    pointersRef.current.set(e.pointerId, canvasPoint(e));
    resetGesture(getCurrentAdjust());
  }

  function handlePointerMove(e: PointerEvent<HTMLCanvasElement>) {
    if (!pointersRef.current.has(e.pointerId)) return;
    pointersRef.current.set(e.pointerId, canvasPoint(e));
    const gesture = gestureRef.current;
    if (!gesture) return;

    if (gesture.mode === "pan") {
      const pt = pointersRef.current.get(e.pointerId)!;
      setCurrentAdjust({
        ...gesture.startAdjust,
        offsetX: gesture.startAdjust.offsetX + (pt.x - gesture.startMid.x) / displayScale,
        offsetY: gesture.startAdjust.offsetY + (pt.y - gesture.startMid.y) / displayScale,
      });
    } else {
      const pts = Array.from(pointersRef.current.values());
      if (pts.length < 2) return;
      const [a, b] = pts;
      const curDist = dist(a, b);
      const curAngle = angleOf(a, b);
      const curMid = midpoint(a, b);
      const scaleFactor = gesture.startDist > 0 ? curDist / gesture.startDist : 1;
      const angleDeltaDeg = ((curAngle - gesture.startAngle) * 180) / Math.PI;
      setCurrentAdjust({
        offsetX: gesture.startAdjust.offsetX + (curMid.x - gesture.startMid.x) / displayScale,
        offsetY: gesture.startAdjust.offsetY + (curMid.y - gesture.startMid.y) / displayScale,
        scale: clamp(gesture.startAdjust.scale * scaleFactor, MIN_SCALE, MAX_SCALE),
        rotationDeg: gesture.startAdjust.rotationDeg + angleDeltaDeg,
      });
    }
  }

  function handlePointerUp(e: PointerEvent<HTMLCanvasElement>) {
    pointersRef.current.delete(e.pointerId);
    resetGesture(getCurrentAdjust());
  }

  function handleWheel(e: WheelEvent<HTMLCanvasElement>) {
    e.preventDefault();
    setCurrentAdjust({ ...getCurrentAdjust(), scale: clamp(getCurrentAdjust().scale * (1 - e.deltaY * 0.001), MIN_SCALE, MAX_SCALE) });
  }

  function handleResetClick() {
    if (!splitMode) {
      setAdjust(DEFAULT_MANUAL_ADJUST);
    } else if (activeRegion === "upper") {
      setUpperAdjust(DEFAULT_MANUAL_ADJUST);
    } else {
      setLowerAdjust(DEFAULT_MANUAL_ADJUST);
    }
  }

  function handleConfirmClick() {
    if (splitMode && onConfirmSplit) {
      onConfirmSplit({ splitY, upper: upperAdjust, lower: lowerAdjust });
    } else {
      onConfirm(adjust);
    }
  }

  return (
    <div className="card" style={{ margin: 0, background: "var(--panel-2)" }}>
      <p className="muted" style={{ marginTop: 0 }}>
        Drag with one finger to move, pinch with two fingers to resize/rotate — dress the anatomy layer exactly onto the body below it.
        {outlineCanvas && " Fit it inside the yellow outline — that's the real body boundary from this exact frame."}
        {maskGray && " This preview already applies the real mask: any spot where the anatomy layer looks faded or missing is a spot the export will also leave as original footage, not a rendering gap."}
      </p>
      <canvas
        ref={canvasRef}
        width={displayW}
        height={displayH}
        style={{
          width: "100%",
          maxWidth: displayW,
          height: "auto",
          touchAction: "none",
          borderRadius: 8,
          border: "1px solid var(--border)",
          cursor: "grab",
          display: "block",
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onWheel={handleWheel}
      />
      <div className="row" style={{ marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
        <label className="muted">
          See-through
          <br />
          <input type="range" min={0.3} max={1} step={0.05} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} />
        </label>
        <button type="button" className="secondary" onClick={handleResetClick}>
          Reset {splitMode ? (activeRegion === "upper" ? "upper" : "lower") : "alignment"}
        </button>
        {outlineCanvas && (
          <label className="muted">
            <input type="checkbox" checked={showTarget} onChange={(e) => setShowTarget(e.target.checked)} /> Show target boundary
          </label>
        )}
      </div>

      {onConfirmSplit && (
        <div className="row" style={{ marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
          <label className="muted">
            <input type="checkbox" checked={splitMode} onChange={(e) => toggleSplitMode(e.target.checked)} /> Split into upper/lower body
          </label>
          {splitMode && (
            <>
              <button
                type="button"
                className={activeRegion === "upper" ? "" : "secondary"}
                onClick={() => setActiveRegion("upper")}
              >
                Editing: upper body
              </button>
              <button
                type="button"
                className={activeRegion === "lower" ? "" : "secondary"}
                onClick={() => setActiveRegion("lower")}
              >
                Editing: lower body
              </button>
              <label className="muted">
                Split line
                <br />
                <input type="range" min={0.2} max={0.8} step={0.01} value={splitY} onChange={(e) => setSplitY(Number(e.target.value))} />
              </label>
            </>
          )}
        </div>
      )}
      {splitMode && (
        <p className="muted" style={{ marginTop: 4 }}>
          A single placement can't fix a bend that differs between the anatomy image and this exact frame — position the upper and lower
          body independently instead. The dimmer half is the one you're not currently editing.
        </p>
      )}

      <div className="row" style={{ marginTop: 12 }}>
        <button type="button" onClick={handleConfirmClick}>
          Confirm this frame
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
