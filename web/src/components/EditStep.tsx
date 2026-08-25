import { useEffect, useRef, useState } from "react";
import { confirmFrame, sendChatEdit, setTimeline, submitPose, uploadAnatomyImage, type TimelineState } from "../api/client";
import { boundsCenter, verticalBounds } from "../cv/alignment";
import { placeAnatomyManually } from "../cv/anatomyFit";
import { detectPose } from "../cv/pose";
import { segmentPerson } from "../cv/segmentation";
import AnatomyAligner from "./AnatomyAligner";
import type { PoseKeypoint } from "../types";

type Phase = "preparing-frame" | "need-anatomy" | "aligning" | "ready" | "error";
type ChatMsg = { role: "user" | "assistant"; text: string };

const DEFAULT_ADJUST = { offsetX: 0, offsetY: 0, scale: 1, rotationDeg: 0 };

function smoothstep(t: number) {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

export default function EditStep({
  sessionId,
  initialFrameUrl,
  initialFreezeSec,
  videoDurationSec,
  onContinue,
}: {
  sessionId: string;
  initialFrameUrl: string;
  initialFreezeSec: number;
  videoDurationSec: number;
  onContinue: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("preparing-frame");
  const [error, setError] = useState<string | null>(null);

  const [frameUrl, setFrameUrl] = useState(initialFrameUrl);
  const [maskVersion, setMaskVersion] = useState(0);
  const [originalPose, setOriginalPose] = useState<PoseKeypoint[] | null>(null);
  const [frameSize, setFrameSize] = useState<{ width: number; height: number } | null>(null);

  const [adjust, setAdjust] = useState(DEFAULT_ADJUST);
  const [anatomyImageUrl, setAnatomyImageUrl] = useState<string | null>(null);

  const [timeline, setTimelineState] = useState<TimelineState>({
    freezeDurationSec: 5,
    transitionInSec: 0.6,
    transitionOutSec: 0.6,
    transitionStyle: "wipe",
    trimStartSec: 0,
    trimEndSec: videoDurationSec,
  });
  const [freezeSec, setFreezeSec] = useState(initialFreezeSec);
  const [freezeSecInput, setFreezeSecInput] = useState(String(initialFreezeSec));

  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);

  const rawAnatomyImgRef = useRef<HTMLImageElement | null>(null);
  const rawAnatomySizeRef = useRef<{ width: number; height: number } | null>(null);
  // The frame's own segmentation mask, loaded as an image so the aligner
  // can trace it into a target-boundary outline to align against.
  const maskImgRef = useRef<HTMLImageElement | null>(null);

  const originalImgRef = useRef<HTMLImageElement | null>(null);
  const maskedLayerRef = useRef<HTMLCanvasElement | null>(null);
  // Cache for the "pixel-dissolve" style's per-cell reveal-order values —
  // recomputed only when the grid size (derived from canvas dimensions)
  // changes, not on every animation frame (this preview redraws up to
  // 60fps; a fresh per-pixel hash every frame would be wasted work for a
  // pattern that never actually changes for a given frame size).
  const pixelDissolveGridRef = useRef<{ cols: number; rows: number; hash: Float32Array } | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const [previewReady, setPreviewReady] = useState(false);
  const [hasPlayedOnce, setHasPlayedOnce] = useState(false);
  const [t, setT] = useState(0.3);
  const [playing, setPlaying] = useState(false);
  const rafRef = useRef<number | null>(null);

  const started = useRef(false);

  // Analyze the (possibly re-picked) original frame: pose + segmentation mask.
  async function prepareFrame(url: string) {
    setPhase("preparing-frame");
    const img = await loadImage(url);
    originalImgRef.current = img;
    const size = { width: img.naturalWidth, height: img.naturalHeight };
    setFrameSize(size);
    const pose = await detectPose(img);
    const maskDataUrl = await segmentPerson(img, size.width, size.height);
    await submitPose(sessionId, pose, maskDataUrl);
    maskImgRef.current = await loadImage(maskDataUrl);
    setOriginalPose(pose);
    setMaskVersion((v) => v + 1);
    setPhase(rawAnatomyImgRef.current ? "aligning" : "need-anatomy");
    return { pose, size };
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    prepareFrame(initialFrameUrl).catch((e) => {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleAnatomyFile(file: File) {
    if (!originalPose || !frameSize) return;
    setPhase("aligning");
    setError(null);
    try {
      const url = URL.createObjectURL(file);
      const img = await loadImage(url);
      rawAnatomyImgRef.current = img;
      rawAnatomySizeRef.current = { width: img.naturalWidth, height: img.naturalHeight };
      setAdjust(DEFAULT_ADJUST);
      await rewarpAndUpload(DEFAULT_ADJUST, frameSize);
      setPhase("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  /**
   * Renders the raw anatomy image onto `size` (the current frame's
   * dimensions) at `manualAdjust` and uploads it. No pose matching, no
   * reshaping — the uploaded image's content is never altered, only
   * positioned (see anatomyFit.ts's doc comment for why: an automatic
   * per-limb warp used to run here, removed after direct user feedback that
   * any automatic reshaping of the uploaded image wasn't acceptable).
   */
  async function rewarpAndUpload(manualAdjust: typeof DEFAULT_ADJUST, size: { width: number; height: number }) {
    const img = rawAnatomyImgRef.current;
    const rawSize = rawAnatomySizeRef.current;
    if (!img || !rawSize) return;

    const canvas = placeAnatomyManually(img, rawSize, size, manualAdjust);

    const dataUrl = canvas.toDataURL("image/png");
    const { imageUrl } = await uploadAnatomyImage(sessionId, dataUrl);
    setAnatomyImageUrl(imageUrl);
  }

  // Large touch-drag/pinch alignment surface, opened on demand instead of
  // small nudge sliders — see AnatomyAligner's doc comment for why: no
  // amount of slider-nudging beats the user directly dragging/pinching the
  // anatomy layer onto the frame with their own eyes and hands.
  const [alignerOpen, setAlignerOpen] = useState(false);

  function openAligner() {
    if (!rawAnatomyImgRef.current || !rawAnatomySizeRef.current || !frameSize) return;
    setAlignerOpen(true);
  }

  async function handleAlignerConfirm(nextAdjust: typeof DEFAULT_ADJUST) {
    setAlignerOpen(false);
    setAdjust(nextAdjust);
    if (!frameSize) return;
    try {
      await rewarpAndUpload(nextAdjust, frameSize);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // Build the "anatomy masked by silhouette" layer for the live preview whenever the anatomy image or mask changes.
  useEffect(() => {
    if (!anatomyImageUrl || !frameSize) return;
    let cancelled = false;
    (async () => {
      try {
        const [anatomy, mask] = await Promise.all([
          loadImage(anatomyImageUrl),
          loadImage(`/api/sessions/${sessionId}/mask?v=${maskVersion}`),
        ]);
        if (cancelled) return;
        const w = frameSize.width;
        const h = frameSize.height;

        const maskCanvas = document.createElement("canvas");
        maskCanvas.width = w;
        maskCanvas.height = h;
        maskCanvas.getContext("2d")!.drawImage(mask, 0, 0, w, h);
        const maskData = maskCanvas.getContext("2d")!.getImageData(0, 0, w, h);

        const anatomyCanvas = document.createElement("canvas");
        anatomyCanvas.width = w;
        anatomyCanvas.height = h;
        anatomyCanvas.getContext("2d")!.drawImage(anatomy, 0, 0, w, h);
        const anatomyData = anatomyCanvas.getContext("2d")!.getImageData(0, 0, w, h);

        const out = anatomyCanvas.getContext("2d")!.createImageData(w, h);
        for (let p = 0; p < w * h; p++) {
          out.data[p * 4] = anatomyData.data[p * 4];
          out.data[p * 4 + 1] = anatomyData.data[p * 4 + 1];
          out.data[p * 4 + 2] = anatomyData.data[p * 4 + 2];
          out.data[p * 4 + 3] = maskData.data[p * 4];
        }
        const maskedLayer = document.createElement("canvas");
        maskedLayer.width = w;
        maskedLayer.height = h;
        maskedLayer.getContext("2d")!.putImageData(out, 0, 0);
        maskedLayerRef.current = maskedLayer;

        const canvas = previewCanvasRef.current;
        if (canvas) {
          canvas.width = w;
          canvas.height = h;
        }
        setPreviewReady(true);
        // Every time the anatomy image changes (new upload, nudge, or a
        // frame change), auto-play the full effect once so it's watched
        // before "Continue to Export" becomes available again.
        setHasPlayedOnce(false);
        setT(0);
        setPlaying(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [anatomyImageUrl, frameSize, maskVersion, sessionId]);

  // Deterministic 2D pixel hash -> [0,1), matching the formula in
  // server/src/lib/compositing.ts's pixelHash01 (kept in sync so the
  // "pixel-dissolve" preview reveals cells in the same relative order the
  // export reveals pixels, even though the preview uses a coarser cell grid
  // for performance rather than literal per-pixel granularity — see the
  // pixelDissolveGridRef comment above).
  function cellHash01(cx: number, cy: number): number {
    let h = (cx * 374761393 + cy * 668265263) | 0;
    h = (h ^ (h >>> 13)) * 1274126177;
    h = h ^ (h >>> 16);
    return (h >>> 0) / 4294967295;
  }

  function wipeLayer(masked: HTMLCanvasElement, phase2: "in" | "hold" | "out", phaseT: number): HTMLCanvasElement {
    const { width, height } = masked;
    if (phase2 === "hold" || !originalPose) return masked;
    const style = timeline.transitionStyle;

    const tmp = document.createElement("canvas");
    tmp.width = width;
    tmp.height = height;
    const tctx = tmp.getContext("2d")!;
    tctx.drawImage(masked, 0, 0);
    tctx.globalCompositeOperation = "destination-in";

    if (style === "dissolve") {
      // A plain uniform crossfade needs no spatial gradient at all — every
      // pixel in the mask fades at the same rate.
      const alpha = phase2 === "in" ? phaseT : 1 - phaseT;
      tctx.fillStyle = `rgba(255,255,255,${alpha})`;
      tctx.fillRect(0, 0, width, height);
    } else if (style === "pixel-dissolve") {
      // Canvas gradients can't express per-pixel noise, so this reveals a
      // coarse cell grid instead of literal pixels — cheap enough to redraw
      // every animation frame, and still reads as "materializing across the
      // whole body at once" rather than any directional sweep. The actual
      // export (server/src/lib/compositing.ts) does true per-pixel reveal;
      // this is a preview approximation of the same effect, not a
      // pixel-exact match.
      const CELL_PX = 22;
      const cols = Math.max(1, Math.round(width / CELL_PX));
      const rows = Math.max(1, Math.round(height / CELL_PX));
      const cached = pixelDissolveGridRef.current;
      let grid = cached && cached.cols === cols && cached.rows === rows ? cached : null;
      if (!grid) {
        const hash = new Float32Array(cols * rows);
        for (let gy = 0; gy < rows; gy++) {
          for (let gx = 0; gx < cols; gx++) hash[gy * cols + gx] = cellHash01(gx, gy);
        }
        grid = { cols, rows, hash };
        pixelDissolveGridRef.current = grid;
      }
      const featherRatio = 0.9;
      const feather = featherRatio; // metric range is [0,1]
      const threshold = -feather / 2 + phaseT * (1 + feather);
      const cellW = width / cols;
      const cellH = height / rows;
      for (let gy = 0; gy < rows; gy++) {
        for (let gx = 0; gx < cols; gx++) {
          const local = (threshold - grid.hash[gy * cols + gx]) / feather + 0.5;
          const covered = smoothstep(local);
          const alpha = phase2 === "in" ? covered : 1 - covered;
          if (alpha <= 0.002) continue;
          tctx.fillStyle = `rgba(255,255,255,${alpha})`;
          tctx.fillRect(gx * cellW, gy * cellH, cellW + 0.5, cellH + 0.5);
        }
      }
    } else {
      // "wipe" / "wipe-reverse" / "radial" all reduce to one threshold
      // sweep with a wide feather band (see server's blendFrameSweep doc
      // comment for why a wide feather reads as the whole figure
      // materializing together rather than a hard-edged line), just with a
      // different gradient geometry.
      let grad: CanvasGradient;
      if (style === "radial") {
        const center = boundsCenter(originalPose);
        const cxPx = center.cx * width;
        const cyPx = center.cy * height;
        const maxRadiusPx = Math.max(
          Math.hypot(cxPx, cyPx),
          Math.hypot(cxPx - width, cyPx),
          Math.hypot(cxPx, cyPx - height),
          Math.hypot(cxPx - width, cyPx - height),
        );
        const feather = maxRadiusPx * 0.55;
        const threshold = -feather / 2 + phaseT * (maxRadiusPx + feather);
        grad = tctx.createRadialGradient(cxPx, cyPx, Math.max(0, threshold - feather / 2), cxPx, cyPx, Math.max(0.01, threshold + feather / 2));
      } else {
        const bounds = verticalBounds(originalPose);
        const span = Math.max(1e-3, bounds.bottom - bounds.top);
        const feather = span * 0.65;
        const reverse = style === "wipe-reverse";
        const top = reverse ? 1 - bounds.bottom : bounds.top;
        const thresholdNorm = top - feather / 2 + phaseT * (span + feather);
        const threshold = thresholdNorm * height;
        const featherPx = feather * height;
        grad = reverse
          ? tctx.createLinearGradient(0, height - (threshold - featherPx / 2), 0, height - (threshold + featherPx / 2))
          : tctx.createLinearGradient(0, threshold - featherPx / 2, 0, threshold + featherPx / 2);
      }
      if (phase2 === "in") {
        grad.addColorStop(0, "rgba(255,255,255,1)");
        grad.addColorStop(1, "rgba(255,255,255,0)");
      } else {
        grad.addColorStop(0, "rgba(255,255,255,0)");
        grad.addColorStop(1, "rgba(255,255,255,1)");
      }
      tctx.fillStyle = grad;
      tctx.fillRect(0, 0, width, height);
    }

    tctx.globalCompositeOperation = "source-over";
    return tmp;
  }

  function drawPreview(currentT: number) {
    const canvas = previewCanvasRef.current;
    const original = originalImgRef.current;
    const masked = maskedLayerRef.current;
    if (!canvas || !original || !masked) return;
    const ctx = canvas.getContext("2d")!;

    let phase2: "in" | "hold" | "out";
    let phaseT: number;
    if (currentT < timeline.transitionInSec) {
      phase2 = "in";
      phaseT = smoothstep(currentT / (timeline.transitionInSec || 1));
    } else if (currentT < timeline.freezeDurationSec - timeline.transitionOutSec) {
      phase2 = "hold";
      phaseT = 1;
    } else {
      phase2 = "out";
      phaseT = smoothstep((currentT - (timeline.freezeDurationSec - timeline.transitionOutSec)) / (timeline.transitionOutSec || 1));
    }
    const layer = wipeLayer(masked, phase2, phaseT);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(original, 0, 0, canvas.width, canvas.height);
    ctx.drawImage(layer, 0, 0, canvas.width, canvas.height);
  }

  useEffect(() => {
    if (previewReady) drawPreview(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewReady, t, timeline]);

  useEffect(() => {
    if (!playing) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      return;
    }
    let start: number | null = null;
    const step = (ts: number) => {
      if (start === null) start = ts;
      const elapsed = (ts - start) / 1000;
      if (elapsed >= timeline.freezeDurationSec) {
        // Completed one full watch-through: stop (don't loop silently) and
        // unlock "Continue to Export" — this is the "approval" moment.
        setT(timeline.freezeDurationSec);
        setPlaying(false);
        setHasPlayedOnce(true);
        return;
      }
      setT(elapsed);
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [playing, timeline.freezeDurationSec]);

  async function persistTimeline(patch: Partial<TimelineState>) {
    try {
      const updated = await setTimeline(sessionId, patch);
      setTimelineState(updated);
      // Timing changed since the last full watch-through: require re-approval.
      setHasPlayedOnce(false);
      setT(0);
      setPlaying(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function applyNewFreezeSec(newSec: number) {
    setError(null);
    try {
      const { freezeSec: confirmed, frameUrl: newUrl } = await confirmFrame(sessionId, newSec);
      setFreezeSec(confirmed);
      setFreezeSecInput(String(confirmed));
      setFrameUrl(`${newUrl}&t=${Date.now()}`);
      const { size } = await prepareFrame(`${newUrl}&t=${Date.now()}`);
      if (rawAnatomyImgRef.current && rawAnatomySizeRef.current) {
        setAdjust(DEFAULT_ADJUST);
        await rewarpAndUpload(DEFAULT_ADJUST, size);
      }
      setPhase("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleChatSend() {
    const text = chatInput.trim();
    if (!text || chatBusy) return;
    setMessages((m) => [...m, { role: "user", text }]);
    setChatInput("");
    setChatBusy(true);
    setError(null);
    try {
      const result = await sendChatEdit(sessionId, text);
      setMessages((m) => [...m, { role: "assistant", text: result.reply }]);
      // The chat endpoint only ever adjusts numeric timing, never the
      // transition style — carry the existing style forward rather than
      // expecting it back from a response that doesn't include it.
      setTimelineState((prev) => ({
        ...prev,
        freezeDurationSec: result.timeline.freezeDurationSec,
        transitionInSec: result.timeline.transitionInSec,
        transitionOutSec: result.timeline.transitionOutSec,
        trimStartSec: result.timeline.trimStartSec,
        trimEndSec: result.timeline.trimEndSec,
      }));

      if (result.frameChanged && result.frameUrl) {
        setFreezeSec(result.timeline.freezeSec);
        setFreezeSecInput(String(result.timeline.freezeSec));
        setFrameUrl(result.frameUrl);
        const { size } = await prepareFrame(result.frameUrl);
        if (rawAnatomyImgRef.current && rawAnatomySizeRef.current) {
          setAdjust(DEFAULT_ADJUST);
          await rewarpAndUpload(DEFAULT_ADJUST, size);
        }
        setPhase("ready");
      } else if (result.anatomyNudge && frameSize) {
        const n = result.anatomyNudge;
        const next = {
          offsetX: adjust.offsetX + (n.offsetXPct ?? 0) * frameSize.width,
          offsetY: adjust.offsetY + (n.offsetYPct ?? 0) * frameSize.height,
          scale: adjust.scale * (n.scaleDelta ?? 1),
          rotationDeg: adjust.rotationDeg + (n.rotationDeltaDeg ?? 0),
        };
        setAdjust(next);
        await rewarpAndUpload(next, frameSize);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setMessages((m) => [...m, { role: "assistant", text: `Error: ${msg}` }]);
    } finally {
      setChatBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>4. Edit</h2>
      <p className="muted">
        Upload an anatomical image, then drag and pinch it into place yourself with "Adjust alignment" — the app never
        alters the image, only positions it exactly where you put it. Then tune timing/trim, or just tell the chat
        what to change.
      </p>

      {phase !== "preparing-frame" && (
        <p className="muted" style={{ marginBottom: 12 }}>
          <a href={frameUrl} download={`frame-${freezeSec.toFixed(2)}s.png`}>
            Download this exact frame
          </a>{" "}
          — feed it into ChatGPT/Sora yourself for the most precise anatomy image, then upload the result below.
        </p>
      )}

      {(phase === "preparing-frame" || phase === "aligning") && (
        <div className="spinner-line">
          <span className="dot" /> {phase === "preparing-frame" ? "Analyzing the frame…" : "Aligning your image…"}
        </div>
      )}

      {(phase === "need-anatomy" || phase === "ready") && (
        <div className="row" style={{ marginBottom: 12 }}>
          <label className="muted">
            {phase === "ready" ? "Replace anatomy image" : "Upload anatomy image"}
            <br />
            <input
              type="file"
              accept="image/*"
              onChange={(e) => {
                const file = e.target.files?.[0];
                // See KeyframesStep.tsx's identical fix: browsers fire no
                // `change` event at all when the same file is re-selected
                // through the native picker, so clearing the input's value
                // here is what makes re-picking the same file actually
                // trigger a fresh fit instead of silently doing nothing.
                e.target.value = "";
                if (file) handleAnatomyFile(file);
              }}
            />
          </label>
        </div>
      )}

      {phase === "ready" && frameSize && (
        <>
          <canvas ref={previewCanvasRef} className="frame-preview" style={{ maxHeight: 420, width: "100%" }} />
          <div className="row" style={{ marginTop: 12 }}>
            <button className="secondary" onClick={() => setPlaying((p) => !p)} disabled={!previewReady}>
              {playing ? "Pause" : "Play"}
            </button>
            <input
              type="range"
              min={0}
              max={timeline.freezeDurationSec}
              step={0.01}
              value={t}
              onChange={(e) => {
                setPlaying(false);
                setT(Number(e.target.value));
              }}
            />
            <span className="muted">
              {t.toFixed(2)}s / {timeline.freezeDurationSec.toFixed(2)}s
            </span>
          </div>

          <div className="row" style={{ marginTop: 16 }}>
            <button type="button" onClick={openAligner}>
              Adjust alignment
            </button>
          </div>

          {alignerOpen && originalImgRef.current && rawAnatomyImgRef.current && rawAnatomySizeRef.current && (
            <div style={{ marginTop: 16 }}>
              <AnatomyAligner
                frameImg={originalImgRef.current}
                frameSize={frameSize}
                anatomyImg={rawAnatomyImgRef.current}
                anatomySize={rawAnatomySizeRef.current}
                initialAdjust={adjust}
                onConfirm={handleAlignerConfirm}
                onCancel={() => setAlignerOpen(false)}
                maskImg={maskImgRef.current ?? undefined}
              />
            </div>
          )}

          <div className="row" style={{ marginTop: 16, flexWrap: "wrap" }}>
            <label className="muted">
              Freeze point (s)<br />
              <input
                type="number"
                min={timeline.trimStartSec}
                max={timeline.trimEndSec}
                step={0.01}
                value={freezeSecInput}
                onChange={(e) => setFreezeSecInput(e.target.value)}
                onBlur={() => {
                  const v = Number(freezeSecInput);
                  if (Number.isFinite(v) && v !== freezeSec) applyNewFreezeSec(v);
                }}
                style={{ width: 90 }}
              />
            </label>
            <label className="muted">
              Hold duration (s)<br />
              <input
                type="number"
                min={1}
                step={0.5}
                value={timeline.freezeDurationSec}
                onChange={(e) => persistTimeline({ freezeDurationSec: Number(e.target.value) })}
                style={{ width: 90 }}
              />
            </label>
            <label className="muted">
              Transition in (s)<br />
              <input
                type="number"
                min={0.1}
                step={0.1}
                value={timeline.transitionInSec}
                onChange={(e) => persistTimeline({ transitionInSec: Number(e.target.value) })}
                style={{ width: 90 }}
              />
            </label>
            <label className="muted">
              Transition out (s)<br />
              <input
                type="number"
                min={0.1}
                step={0.1}
                value={timeline.transitionOutSec}
                onChange={(e) => persistTimeline({ transitionOutSec: Number(e.target.value) })}
                style={{ width: 90 }}
              />
            </label>
            <label className="muted">
              Transition effect<br />
              <select
                value={timeline.transitionStyle}
                onChange={(e) => persistTimeline({ transitionStyle: e.target.value as TimelineState["transitionStyle"] })}
              >
                <option value="wipe">Head to foot</option>
                <option value="wipe-reverse">Foot to head</option>
                <option value="radial">Grows from within</option>
                <option value="pixel-dissolve">Materializes gradually</option>
                <option value="dissolve">Simple fade</option>
              </select>
            </label>
            <label className="muted">
              Trim start (s)<br />
              <input
                type="number"
                min={0}
                max={videoDurationSec}
                step={0.1}
                value={timeline.trimStartSec}
                onChange={(e) => persistTimeline({ trimStartSec: Number(e.target.value) })}
                style={{ width: 90 }}
              />
            </label>
            <label className="muted">
              Trim end (s)<br />
              <input
                type="number"
                min={0}
                max={videoDurationSec}
                step={0.1}
                value={timeline.trimEndSec}
                onChange={(e) => persistTimeline({ trimEndSec: Number(e.target.value) })}
                style={{ width: 90 }}
              />
            </label>
          </div>

          <div style={{ marginTop: 20 }}>
            <p className="muted" style={{ marginBottom: 8 }}>
              Or just tell the AI what to change:
            </p>
            <div
              style={{
                maxHeight: 200,
                overflowY: "auto",
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: 10,
                marginBottom: 8,
                background: "var(--panel-2)",
              }}
            >
              {messages.length === 0 && <p className="muted" style={{ margin: 0 }}>e.g. "hold it 2 seconds longer" or "move the anatomy right a bit"</p>}
              {messages.map((m, i) => (
                <p key={i} style={{ margin: "4px 0", color: m.role === "user" ? "var(--text)" : "var(--accent-bright)" }}>
                  <strong>{m.role === "user" ? "You" : "AI"}:</strong> {m.text}
                </p>
              ))}
            </div>
            <div className="row">
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleChatSend()}
                placeholder="Describe the change you want…"
                style={{ flex: 1 }}
                disabled={chatBusy}
              />
              <button onClick={handleChatSend} disabled={chatBusy || !chatInput.trim()}>
                {chatBusy ? "…" : "Send"}
              </button>
            </div>
          </div>

          <div className="row" style={{ marginTop: 20, alignItems: "center" }}>
            <button onClick={onContinue} disabled={!hasPlayedOnce}>
              Approve & Continue to Export
            </button>
            {!hasPlayedOnce && <span className="muted">Watch the full preview above (playing automatically) to approve.</span>}
          </div>
        </>
      )}

      {error && <div className="error-box">{error}</div>}
    </div>
  );
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
    img.src = src;
  });
}
