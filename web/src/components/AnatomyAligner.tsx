import { useEffect, useMemo, useRef, useState, type PointerEvent, type WheelEvent } from "react";
import { composeManualAdjustment } from "../cv/alignment";
import { centerFitTransform, DEFAULT_MANUAL_ADJUST, type ManualAdjust } from "../cv/anatomyFit";

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
}

/**
 * Traces a greyscale person mask into a thin colored outline (the mask's
 * own silhouette edge — where confidence crosses ~50%), at the aligner's
 * display resolution. This is the visual "target boundary" the user aligns
 * the anatomy image against, turning positioning from "eyeball it against
 * the photo" into "fit inside the line" — closer to a matching-game/sticker
 * task than free-form guessing. Purely a positioning aid: it plays no part
 * in the actual export compositing, which uses the full-resolution mask
 * directly (server/src/lib/compositing.ts).
 */
function buildMaskOutline(maskImg: HTMLImageElement, width: number, height: number): HTMLCanvasElement {
  const src = document.createElement("canvas");
  src.width = width;
  src.height = height;
  const sctx = src.getContext("2d")!;
  sctx.drawImage(maskImg, 0, 0, width, height);
  const gray = sctx.getImageData(0, 0, width, height).data;

  const THRESHOLD = 128;
  const inside = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) inside[i] = gray[i * 4] >= THRESHOLD ? 1 : 0;

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
}: AnatomyAlignerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [adjust, setAdjust] = useState<ManualAdjust>(initialAdjust);
  const [opacity, setOpacity] = useState(0.65);
  const [showTarget, setShowTarget] = useState(true);
  const pointersRef = useRef<Map<number, PointerPt>>(new Map());
  const gestureRef = useRef<GestureState | null>(null);

  const displayW = Math.min(MAX_DISPLAY_WIDTH, frameSize.width);
  const displayH = Math.round(displayW * (frameSize.height / frameSize.width));
  const displayScale = displayW / frameSize.width;
  const pivotX = frameSize.width / 2;
  const pivotY = frameSize.height / 2;
  const baseTransform = centerFitTransform(anatomySize, frameSize);

  // Computed once per (mask, display size) — not on every drag frame — since
  // it's a fixed reference the anatomy layer moves over, not something that
  // itself needs to redraw during a gesture.
  const outlineCanvas = useMemo(() => (maskImg ? buildMaskOutline(maskImg, displayW, displayH) : null), [maskImg, displayW, displayH]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(frameImg, 0, 0, displayW, displayH);

    const full = composeManualAdjustment(baseTransform, adjust, { x: pivotX, y: pivotY });
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.setTransform(
      full.a * displayScale,
      full.b * displayScale,
      full.c * displayScale,
      full.d * displayScale,
      full.tx * displayScale,
      full.ty * displayScale,
    );
    ctx.drawImage(anatomyImg, 0, 0);
    ctx.restore();

    // Drawn last, always at full opacity, independent of the see-through
    // slider above — a fixed target boundary to fit the anatomy layer
    // inside, like a matching-game outline, rather than a preview layer.
    if (showTarget && outlineCanvas) {
      ctx.drawImage(outlineCanvas, 0, 0);
    }
  }, [adjust, opacity, showTarget, frameImg, anatomyImg, baseTransform, outlineCanvas, displayW, displayH, displayScale, pivotX, pivotY]);

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
    resetGesture(adjust);
  }

  function handlePointerMove(e: PointerEvent<HTMLCanvasElement>) {
    if (!pointersRef.current.has(e.pointerId)) return;
    pointersRef.current.set(e.pointerId, canvasPoint(e));
    const gesture = gestureRef.current;
    if (!gesture) return;

    if (gesture.mode === "pan") {
      const pt = pointersRef.current.get(e.pointerId)!;
      setAdjust({
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
      setAdjust({
        offsetX: gesture.startAdjust.offsetX + (curMid.x - gesture.startMid.x) / displayScale,
        offsetY: gesture.startAdjust.offsetY + (curMid.y - gesture.startMid.y) / displayScale,
        scale: clamp(gesture.startAdjust.scale * scaleFactor, MIN_SCALE, MAX_SCALE),
        rotationDeg: gesture.startAdjust.rotationDeg + angleDeltaDeg,
      });
    }
  }

  function handlePointerUp(e: PointerEvent<HTMLCanvasElement>) {
    pointersRef.current.delete(e.pointerId);
    resetGesture(adjust);
  }

  function handleWheel(e: WheelEvent<HTMLCanvasElement>) {
    e.preventDefault();
    setAdjust((a) => ({ ...a, scale: clamp(a.scale * (1 - e.deltaY * 0.001), MIN_SCALE, MAX_SCALE) }));
  }

  return (
    <div className="card" style={{ margin: 0, background: "var(--panel-2)" }}>
      <p className="muted" style={{ marginTop: 0 }}>
        Drag with one finger to move, pinch with two fingers to resize/rotate — dress the anatomy layer exactly onto the body below it.
        {outlineCanvas && " Fit it inside the yellow outline — that's the real body boundary from this exact frame."}
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
        <button type="button" className="secondary" onClick={() => setAdjust(DEFAULT_MANUAL_ADJUST)}>
          Reset alignment
        </button>
        {outlineCanvas && (
          <label className="muted">
            <input type="checkbox" checked={showTarget} onChange={(e) => setShowTarget(e.target.checked)} /> Show target boundary
          </label>
        )}
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <button type="button" onClick={() => onConfirm(adjust)}>
          Confirm this frame
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
