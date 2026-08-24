import { useEffect, useRef, useState } from "react";
import { confirmFrame, sendChatEdit, setTimeline, submitPose, uploadAnatomyImage, type TimelineState } from "../api/client";
import {
  composeManualAdjustment,
  fitSimilarityTransform,
  verticalBounds,
  warpImageToCanvas,
  type AffineTransform,
  IDENTITY_TRANSFORM,
} from "../cv/alignment";
import { BONE_SEGMENTS, computeSegmentTransforms, renderSkeletalPuppetFrameFromPoses } from "../cv/limbWarp";
import { detectPose } from "../cv/pose";
import { segmentPerson } from "../cv/segmentation";
import type { PoseKeypoint } from "../types";

type Phase = "preparing-frame" | "need-anatomy" | "aligning" | "ready" | "error";
type ChatMsg = { role: "user" | "assistant"; text: string };
type MatchInfo =
  | { mode: "puppet"; matched: number; total: number }
  | { mode: "rigid"; matched: number; total: number }
  | { mode: "center" };

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

  const [matchInfo, setMatchInfo] = useState<MatchInfo | null>(null);
  const [adjust, setAdjust] = useState(DEFAULT_ADJUST);
  const [anatomyImageUrl, setAnatomyImageUrl] = useState<string | null>(null);

  const [timeline, setTimelineState] = useState<TimelineState>({
    freezeDurationSec: 5,
    transitionInSec: 0.6,
    transitionOutSec: 0.6,
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
  const uploadedPoseRef = useRef<PoseKeypoint[]>([]);
  // Mirrors `originalPose` state but updates synchronously, so rewarpAndUpload
  // (called right after prepareFrame sets a new pose) never reads a stale
  // value from before that state update has re-rendered.
  const originalPoseRef = useRef<PoseKeypoint[] | null>(null);

  const originalImgRef = useRef<HTMLImageElement | null>(null);
  const maskedLayerRef = useRef<HTMLCanvasElement | null>(null);
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
    originalPoseRef.current = pose;
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
      uploadedPoseRef.current = await detectPose(img).catch(() => [] as PoseKeypoint[]);
      setAdjust(DEFAULT_ADJUST);
      await rewarpAndUpload(DEFAULT_ADJUST, frameSize);
      setPhase("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  /**
   * Fits the raw anatomy image onto `size` (the current frame's dimensions)
   * against `originalPose`, then applies the manual nudge on top, and
   * uploads the result. Prefers a full per-limb "skeletal puppet" warp
   * (web/src/cv/limbWarp.ts — the same mechanism continuous mode uses) over
   * a rigid whole-image fit whenever every bone segment can be resolved:
   * that's what lets a *generic* standing anatomy image get bent to match
   * this exact exercise pose, not just uniformly scaled/rotated/positioned
   * onto it. Falls back to the rigid similarity fit (or a centered
   * scale-to-fit) when the anatomy image's pose detection is incomplete —
   * a partial puppet would leave visible gaps where unresolved limbs simply
   * aren't drawn, which looks worse than a slightly-misaligned whole image.
   */
  async function rewarpAndUpload(manualAdjust: typeof DEFAULT_ADJUST, size: { width: number; height: number }) {
    const img = rawAnatomyImgRef.current;
    const rawSize = rawAnatomySizeRef.current;
    const targetPose = originalPoseRef.current;
    if (!img || !rawSize || !targetPose) return;
    const uploadedPose = uploadedPoseRef.current;

    let baseCanvas: HTMLCanvasElement | HTMLImageElement = img;
    if (uploadedPose.length > 0) {
      const segments = computeSegmentTransforms(uploadedPose, targetPose, rawSize, size);
      if (segments.size === BONE_SEGMENTS.length) {
        baseCanvas = renderSkeletalPuppetFrameFromPoses(img, uploadedPose, targetPose, rawSize, size);
        setMatchInfo({ mode: "puppet", matched: segments.size, total: BONE_SEGMENTS.length });
      } else {
        const fit = fitSimilarityTransform(uploadedPose, targetPose, rawSize, size);
        const t = fit.matchedPoints >= 3 ? fit.transform : centerFitTransform(rawSize, size);
        baseCanvas = warpImageToCanvas(img, t, size.width, size.height);
        setMatchInfo(
          fit.matchedPoints >= 3
            ? { mode: "rigid", matched: fit.matchedPoints, total: fit.candidatePoints }
            : { mode: "center" },
        );
      }
    } else {
      baseCanvas = warpImageToCanvas(img, centerFitTransform(rawSize, size), size.width, size.height);
      setMatchInfo({ mode: "center" });
    }

    const pivot = { x: size.width / 2, y: size.height / 2 };
    const nudgeTransform = composeManualAdjustment(IDENTITY_TRANSFORM, manualAdjust, pivot);
    const canvas = warpImageToCanvas(baseCanvas, nudgeTransform, size.width, size.height);
    const dataUrl = canvas.toDataURL("image/png");
    const { imageUrl } = await uploadAnatomyImage(sessionId, dataUrl);
    setAnatomyImageUrl(imageUrl);
  }

  // Debounced re-warp+upload whenever the nudge sliders change (avoid spamming uploads while dragging).
  const nudgeDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  function scheduleRewarp(nextAdjust: typeof DEFAULT_ADJUST) {
    setAdjust(nextAdjust);
    if (nudgeDebounce.current) clearTimeout(nudgeDebounce.current);
    nudgeDebounce.current = setTimeout(() => {
      if (frameSize) rewarpAndUpload(nextAdjust, frameSize).catch((e) => setError(e instanceof Error ? e.message : String(e)));
    }, 300);
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

  function wipeLayer(masked: HTMLCanvasElement, phase2: "in" | "hold" | "out", phaseT: number): HTMLCanvasElement {
    const { width, height } = masked;
    if (phase2 === "hold" || !originalPose) return masked;
    const bounds = verticalBounds(originalPose);
    const span = Math.max(1e-3, bounds.bottom - bounds.top);
    const feather = span * 0.12;
    const thresholdNorm = bounds.top - feather / 2 + phaseT * (span + feather);
    const threshold = thresholdNorm * height;
    const featherPx = feather * height;

    const tmp = document.createElement("canvas");
    tmp.width = width;
    tmp.height = height;
    const tctx = tmp.getContext("2d")!;
    tctx.drawImage(masked, 0, 0);
    tctx.globalCompositeOperation = "destination-in";
    const grad = tctx.createLinearGradient(0, threshold - featherPx / 2, 0, threshold + featherPx / 2);
    if (phase2 === "in") {
      grad.addColorStop(0, "rgba(255,255,255,1)");
      grad.addColorStop(1, "rgba(255,255,255,0)");
    } else {
      grad.addColorStop(0, "rgba(255,255,255,0)");
      grad.addColorStop(1, "rgba(255,255,255,1)");
    }
    tctx.fillStyle = grad;
    tctx.fillRect(0, 0, width, height);
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
      setTimelineState({
        freezeDurationSec: result.timeline.freezeDurationSec,
        transitionInSec: result.timeline.transitionInSec,
        transitionOutSec: result.timeline.transitionOutSec,
        trimStartSec: result.timeline.trimStartSec,
        trimEndSec: result.timeline.trimEndSec,
      });

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
        Upload an anatomical image — even a generic standing reference, not one made for this exact pose — and the app
        bends it joint by joint to match this frame automatically. Then tune timing/trim, or just tell the chat what
        to change.
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
                if (file) handleAnatomyFile(file);
              }}
            />
          </label>
        </div>
      )}

      {matchInfo && phase === "ready" && (
        <p className="muted">
          {matchInfo.mode === "puppet" &&
            `Bent every body segment (${matchInfo.matched}/${matchInfo.total}) to match this exact pose — works even with a generic standing anatomy image.`}
          {matchInfo.mode === "rigid" &&
            `Auto-aligned as a whole image using ${matchInfo.matched} of ${matchInfo.total} detected joints (not enough segments matched for a full per-limb fit — use the sliders or chat to fine-tune).`}
          {matchInfo.mode === "center" &&
            "Couldn't reliably detect a pose in your image — placed it centered; use the sliders or chat to align it."}
        </p>
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

          <div className="row" style={{ marginTop: 16, flexWrap: "wrap" }}>
            <label className="muted">
              Anatomy position X<br />
              <input
                type="range"
                min={-frameSize.width * 0.3}
                max={frameSize.width * 0.3}
                value={adjust.offsetX}
                onChange={(e) => scheduleRewarp({ ...adjust, offsetX: Number(e.target.value) })}
              />
            </label>
            <label className="muted">
              Position Y<br />
              <input
                type="range"
                min={-frameSize.height * 0.3}
                max={frameSize.height * 0.3}
                value={adjust.offsetY}
                onChange={(e) => scheduleRewarp({ ...adjust, offsetY: Number(e.target.value) })}
              />
            </label>
            <label className="muted">
              Size<br />
              <input
                type="range"
                min={0.5}
                max={1.5}
                step={0.01}
                value={adjust.scale}
                onChange={(e) => scheduleRewarp({ ...adjust, scale: Number(e.target.value) })}
              />
            </label>
            <label className="muted">
              Rotate<br />
              <input
                type="range"
                min={-15}
                max={15}
                step={0.5}
                value={adjust.rotationDeg}
                onChange={(e) => scheduleRewarp({ ...adjust, rotationDeg: Number(e.target.value) })}
              />
            </label>
          </div>

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

function centerFitTransform(src: { width: number; height: number }, dst: { width: number; height: number }): AffineTransform {
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

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
    img.src = src;
  });
}
