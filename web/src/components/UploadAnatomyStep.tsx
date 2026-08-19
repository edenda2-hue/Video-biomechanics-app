import { useEffect, useRef, useState } from "react";
import { submitPose, uploadAnatomyImage } from "../api/client";
import { composeManualAdjustment, fitSimilarityTransform, warpImageToCanvas, type AffineTransform, IDENTITY_TRANSFORM } from "../cv/alignment";
import { detectPose } from "../cv/pose";
import { segmentPerson } from "../cv/segmentation";
import type { PoseKeypoint } from "../types";

type Phase = "preparing" | "ready-for-upload" | "aligning" | "reviewing" | "confirming" | "error";

const DEFAULT_ADJUST = { offsetX: 0, offsetY: 0, scale: 1, rotationDeg: 0 };

export default function UploadAnatomyStep({
  sessionId,
  frameUrl,
  onApproved,
}: {
  sessionId: string;
  frameUrl: string;
  onApproved: (pose: PoseKeypoint[], anatomyImageUrl: string) => void;
}) {
  const [phase, setPhase] = useState<Phase>("preparing");
  const [error, setError] = useState<string | null>(null);
  const [originalPose, setOriginalPose] = useState<PoseKeypoint[] | null>(null);
  const [frameSize, setFrameSize] = useState<{ width: number; height: number } | null>(null);
  const [autoTransform, setAutoTransform] = useState<AffineTransform>(IDENTITY_TRANSFORM);
  const [matchInfo, setMatchInfo] = useState<{ matchedPoints: number; rmsError: number } | null>(null);
  const [adjust, setAdjust] = useState(DEFAULT_ADJUST);
  const [percent, setPercent] = useState(50);
  const [busy, setBusy] = useState(false);

  const uploadedImgRef = useRef<HTMLImageElement | null>(null);
  const uploadedSizeRef = useRef<{ width: number; height: number } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const started = useRef(false);

  // Prepare the original frame: pose + segmentation mask (needed for
  // alignment target and for the video engine's person mask).
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      try {
        const img = await loadImage(frameUrl);
        setFrameSize({ width: img.naturalWidth, height: img.naturalHeight });
        const pose = await detectPose(img);
        const maskDataUrl = await segmentPerson(img, img.naturalWidth, img.naturalHeight);
        await submitPose(sessionId, pose, maskDataUrl);
        setOriginalPose(pose);
        setPhase("ready-for-upload");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    })();
  }, [sessionId, frameUrl]);

  async function handleFile(file: File) {
    if (!originalPose || !frameSize) return;
    setPhase("aligning");
    setError(null);
    try {
      const url = URL.createObjectURL(file);
      const img = await loadImage(url);
      uploadedImgRef.current = img;
      uploadedSizeRef.current = { width: img.naturalWidth, height: img.naturalHeight };

      const uploadedPose = await detectPose(img).catch(() => [] as PoseKeypoint[]);
      const fit = fitSimilarityTransform(uploadedPose, originalPose, uploadedSizeRef.current, frameSize);
      setMatchInfo({ matchedPoints: fit.matchedPoints, rmsError: fit.rmsError });
      setAutoTransform(fit.matchedPoints >= 3 ? fit.transform : centerFitTransform(uploadedSizeRef.current, frameSize));
      setAdjust(DEFAULT_ADJUST);
      setPhase("reviewing");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  // Redraw the warped preview whenever the auto-fit or manual nudge changes.
  useEffect(() => {
    if (phase !== "reviewing" || !uploadedImgRef.current || !frameSize) return;
    const pivot = { x: frameSize.width / 2, y: frameSize.height / 2 };
    const finalTransform = composeManualAdjustment(autoTransform, adjust, pivot);
    const canvas = warpImageToCanvas(uploadedImgRef.current, finalTransform, frameSize.width, frameSize.height);
    const target = canvasRef.current;
    if (!target) return;
    target.width = frameSize.width;
    target.height = frameSize.height;
    target.getContext("2d")!.drawImage(canvas, 0, 0);
  }, [phase, autoTransform, adjust, frameSize]);

  function updateFromEvent(clientX: number) {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPercent(Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100)));
  }

  async function handleConfirm() {
    if (!canvasRef.current) return;
    setBusy(true);
    setError(null);
    try {
      const dataUrl = canvasRef.current.toDataURL("image/png");
      const { imageUrl } = await uploadAnatomyImage(sessionId, dataUrl);
      onApproved(originalPose!, imageUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>3. Upload Anatomy Image</h2>
      <p className="muted">
        Upload the anatomical image you created for this exact frame. The app detects the pose in both images and
        automatically aligns yours on top of the original — no AI generation, no cost.
      </p>

      {(phase === "preparing" || phase === "aligning") && (
        <div className="spinner-line">
          <span className="dot" /> {phase === "preparing" ? "Analyzing the original frame…" : "Aligning your image…"}
        </div>
      )}

      {phase === "ready-for-upload" && (
        <div className="row">
          <input
            type="file"
            accept="image/*"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
            }}
          />
        </div>
      )}

      {(phase === "reviewing" || phase === "confirming") && frameSize && (
        <>
          {matchInfo && (
            <p className="muted">
              {matchInfo.matchedPoints >= 3
                ? `Auto-aligned using ${matchInfo.matchedPoints} matched joints (fit error ${matchInfo.rmsError.toFixed(0)}px). Fine-tune below if needed.`
                : "Couldn't reliably detect a pose in your image — placed it centered. Use the sliders below to align it manually."}
            </p>
          )}

          <div
            ref={wrapRef}
            className="compare-wrap"
            onMouseDown={(e) => updateFromEvent(e.clientX)}
            onMouseMove={(e) => e.buttons === 1 && updateFromEvent(e.clientX)}
          >
            <img src={frameUrl} alt="Original" draggable={false} />
            <canvas
              ref={canvasRef}
              style={{ position: "absolute", top: 0, left: 0, width: "100%", clipPath: `inset(0 ${100 - percent}% 0 0)` }}
            />
            <div className="compare-handle" style={{ left: `${percent}%` }} />
          </div>

          <div className="row" style={{ marginTop: 16, flexWrap: "wrap" }}>
            <label className="muted">
              Move X<br />
              <input
                type="range"
                min={-frameSize.width * 0.3}
                max={frameSize.width * 0.3}
                value={adjust.offsetX}
                onChange={(e) => setAdjust((a) => ({ ...a, offsetX: Number(e.target.value) }))}
              />
            </label>
            <label className="muted">
              Move Y<br />
              <input
                type="range"
                min={-frameSize.height * 0.3}
                max={frameSize.height * 0.3}
                value={adjust.offsetY}
                onChange={(e) => setAdjust((a) => ({ ...a, offsetY: Number(e.target.value) }))}
              />
            </label>
            <label className="muted">
              Scale<br />
              <input
                type="range"
                min={0.5}
                max={1.5}
                step={0.01}
                value={adjust.scale}
                onChange={(e) => setAdjust((a) => ({ ...a, scale: Number(e.target.value) }))}
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
                onChange={(e) => setAdjust((a) => ({ ...a, rotationDeg: Number(e.target.value) }))}
              />
            </label>
            <button className="secondary" onClick={() => setAdjust(DEFAULT_ADJUST)}>
              Reset nudge
            </button>
          </div>

          <div className="row" style={{ marginTop: 16 }}>
            <button onClick={handleConfirm} disabled={busy}>
              {busy ? "Saving…" : "Confirm Alignment"}
            </button>
          </div>
        </>
      )}

      {error && <div className="error-box">{error}</div>}
    </div>
  );
}

/** Fallback when auto-alignment can't find enough matched joints: center the uploaded image, scaled to fit. */
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
