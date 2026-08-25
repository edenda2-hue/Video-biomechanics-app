import { useEffect, useRef, useState } from "react";
import {
  addKeyframe,
  deleteKeyframe,
  getKeyframesExportStatus,
  startKeyframesExport,
  submitKeyframePose,
  updateKeyframe,
  uploadKeyframeAnatomy,
  type ExportJobStatus,
} from "../api/client";
import { fitAnatomyToPose, type AnatomyFitInfo } from "../cv/anatomyFit";
import { useJobPolling } from "../hooks/useJobPolling";
import { detectPose } from "../cv/pose";
import { segmentPerson } from "../cv/segmentation";
import type { PoseKeypoint, TransitionStyle, VideoMetadata } from "../types";

const PHASE_LABEL: Record<ExportJobStatus["phase"], string> = {
  compositing: "Compositing the keyframe anatomy",
  "encoding-segment": "Encoding the keyframe segment",
  assembling: "Splicing into the original video",
  done: "Done",
  error: "Failed",
};

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
    img.src = src;
  });
}

interface KeyframeEntry {
  id: string;
  timeSec: number;
  frameUrl: string;
  framePose: PoseKeypoint[] | null;
  frameSize: { width: number; height: number } | null;
  anatomyImageUrl: string | null;
  matchInfo: AnatomyFitInfo | null;
  holdDurationSec: number;
  transitionInSec: number;
  transitionOutSec: number;
  transitionStyle: TransitionStyle;
  busy: boolean;
  error: string | null;
}

/**
 * "Anatomy Keyframes" mode: as many freeze points as you choose, each
 * anchored to a real frame you can download and generate a precise anatomy
 * image for externally (ChatGPT/Sora/etc.), then upload back — the same
 * external-generation workflow the single-freeze flow uses, generalized to
 * N points instead of one. Every keyframe's swap excludes the head, so the
 * real person's head/face always shows through — only the body underneath
 * becomes anatomical.
 */
export default function KeyframesStep({ sessionId, file, metadata }: { sessionId: string; file: File; metadata: VideoMetadata }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [pickTime, setPickTime] = useState(Math.min(1, metadata.durationSec / 2));
  const [keyframes, setKeyframes] = useState<KeyframeEntry[]>([]);
  const [addingKeyframe, setAddingKeyframe] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const { status, setStatus, error, setError, start: startPolling, stop: stopPolling } = useJobPolling(getKeyframesExportStatus);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.currentTime = pickTime;
  }, [pickTime]);

  useEffect(() => stopPolling, [stopPolling]);

  async function handleAddKeyframe() {
    setAddingKeyframe(true);
    setError(null);
    try {
      const { id, timeSec, frameUrl } = await addKeyframe(sessionId, pickTime);
      const url = `${frameUrl}?t=${Date.now()}`;
      const img = await loadImage(url);
      const frameSize = { width: img.naturalWidth, height: img.naturalHeight };
      const framePose = await detectPose(img);
      const maskDataUrl = await segmentPerson(img, frameSize.width, frameSize.height);
      await submitKeyframePose(sessionId, id, framePose, maskDataUrl);

      setKeyframes((kfs) =>
        [
          ...kfs,
          {
            id,
            timeSec,
            frameUrl: url,
            framePose,
            frameSize,
            anatomyImageUrl: null,
            matchInfo: null,
            holdDurationSec: 3,
            transitionInSec: 0.4,
            transitionOutSec: 0.4,
            transitionStyle: "wipe" as const,
            busy: false,
            error: null,
          },
        ].sort((a, b) => a.timeSec - b.timeSec),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAddingKeyframe(false);
    }
  }

  function patchKeyframe(id: string, patch: Partial<KeyframeEntry>) {
    setKeyframes((kfs) => kfs.map((k) => (k.id === id ? { ...k, ...patch } : k)));
  }

  async function handleAnatomyFile(kf: KeyframeEntry, file: File) {
    if (!kf.framePose || !kf.frameSize) return;
    patchKeyframe(kf.id, { busy: true, error: null });
    try {
      const url = URL.createObjectURL(file);
      const img = await loadImage(url);
      const rawSize = { width: img.naturalWidth, height: img.naturalHeight };
      const rawPose = await detectPose(img).catch(() => [] as PoseKeypoint[]);

      const { canvas, info } = fitAnatomyToPose(img, rawPose, rawSize, kf.framePose, kf.frameSize);
      const { imageUrl } = await uploadKeyframeAnatomy(sessionId, kf.id, canvas.toDataURL("image/png"));

      patchKeyframe(kf.id, { anatomyImageUrl: `${imageUrl}`, matchInfo: info, busy: false });
    } catch (e) {
      patchKeyframe(kf.id, { busy: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  const timingDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  function scheduleTimingUpdate(
    kf: KeyframeEntry,
    patch: { holdDurationSec?: number; transitionInSec?: number; transitionOutSec?: number; transitionStyle?: TransitionStyle },
  ) {
    patchKeyframe(kf.id, patch);
    if (timingDebounce.current) clearTimeout(timingDebounce.current);
    timingDebounce.current = setTimeout(() => {
      updateKeyframe(sessionId, kf.id, patch).catch((e) => patchKeyframe(kf.id, { error: e instanceof Error ? e.message : String(e) }));
    }, 400);
  }

  async function handleDelete(kf: KeyframeEntry) {
    try {
      await deleteKeyframe(sessionId, kf.id);
      setKeyframes((kfs) => kfs.filter((k) => k.id !== kf.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleExport() {
    setExportBusy(true);
    setError(null);
    setStatus(null);
    try {
      await startKeyframesExport(sessionId);
      setStatus({ phase: "compositing", percent: 0, message: PHASE_LABEL.compositing });
      startPolling(sessionId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExportBusy(false);
    }
  }

  const rendering = status && status.phase !== "done" && status.phase !== "error";
  const allReady = keyframes.length > 0 && keyframes.every((k) => k.anatomyImageUrl);

  return (
    <div className="card">
      <h2>3. Anatomy Keyframes</h2>
      <p className="muted">
        Pick as many moments as you want; each becomes an anatomy freeze point — the body swaps to anatomy (the head always stays the
        real person), holds for a duration you choose, then the original resumes. Download each frame and generate a precise anatomy
        image for it externally for the most accurate result, or upload a generic reference and let the app fit it automatically. You
        can keep editing everything below until you export.
      </p>

      {objectUrl && <video ref={videoRef} src={objectUrl} className="frame-preview" style={{ maxHeight: 280 }} controls={false} muted />}

      <div className="row" style={{ marginTop: 12 }}>
        <input
          type="range"
          min={0}
          max={metadata.durationSec}
          step={1 / metadata.fps}
          value={pickTime}
          onChange={(e) => setPickTime(Number(e.target.value))}
        />
        <input
          type="number"
          min={0}
          max={metadata.durationSec}
          step={1 / metadata.fps}
          value={pickTime.toFixed(2)}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) setPickTime(Math.min(metadata.durationSec, Math.max(0, v)));
          }}
          style={{ width: 90 }}
        />
        <span className="muted">seconds / {metadata.durationSec.toFixed(2)}s total</span>
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <button onClick={handleAddKeyframe} disabled={addingKeyframe}>
          {addingKeyframe ? "Adding…" : "+ Add Keyframe at this time"}
        </button>
      </div>

      {keyframes.length > 0 && (
        <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 16 }}>
          {keyframes.map((kf) => (
            <div key={kf.id} className="card" style={{ margin: 0 }}>
              <div className="row" style={{ alignItems: "flex-start", gap: 16 }}>
                <img src={kf.anatomyImageUrl ?? kf.frameUrl} alt="keyframe" style={{ width: 140, borderRadius: 8, border: "1px solid var(--border)" }} />
                <div style={{ flex: 1 }}>
                  <p style={{ margin: "0 0 8px" }}>
                    <strong>Keyframe at {kf.timeSec.toFixed(2)}s</strong>
                  </p>
                  <p className="muted" style={{ margin: "0 0 8px" }}>
                    <a href={kf.frameUrl} download={`keyframe-${kf.timeSec.toFixed(2)}s.png`}>
                      Download this exact frame
                    </a>{" "}
                    — feed it into ChatGPT/Sora for the most precise anatomy image.
                  </p>
                  <label className="muted">
                    {kf.anatomyImageUrl ? "Replace anatomy image" : "Upload anatomy image"}
                    <br />
                    <input
                      type="file"
                      accept="image/*"
                      disabled={kf.busy}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) handleAnatomyFile(kf, f);
                      }}
                    />
                  </label>
                  {kf.busy && <p className="muted">Fitting…</p>}
                  {kf.matchInfo && (
                    <p className="muted" style={{ marginTop: 4 }}>
                      {kf.matchInfo.mode === "puppet" &&
                        (kf.matchInfo.gapsFilled
                          ? `Bent ${kf.matchInfo.matched} of ${kf.matchInfo.total} body segments to match this frame (rest filled from a whole-image fit).`
                          : `Bent every body segment (${kf.matchInfo.matched}/${kf.matchInfo.total}) to match this frame.`)}
                      {kf.matchInfo.mode === "rigid" && `Auto-aligned as a whole image (${kf.matchInfo.matched}/${kf.matchInfo.total} joints matched).`}
                      {kf.matchInfo.mode === "center" && "Couldn't reliably detect a pose — placed centered."}
                    </p>
                  )}
                  {kf.error && <div className="error-box">{kf.error}</div>}

                  <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
                    <label className="muted">
                      Hold duration (s)
                      <br />
                      <input
                        type="number"
                        min={1}
                        step={0.5}
                        value={kf.holdDurationSec}
                        onChange={(e) => scheduleTimingUpdate(kf, { holdDurationSec: Number(e.target.value) })}
                        style={{ width: 90 }}
                      />
                    </label>
                    <label className="muted">
                      Transition in (s)
                      <br />
                      <input
                        type="number"
                        min={0.1}
                        step={0.1}
                        value={kf.transitionInSec}
                        onChange={(e) => scheduleTimingUpdate(kf, { transitionInSec: Number(e.target.value) })}
                        style={{ width: 90 }}
                      />
                    </label>
                    <label className="muted">
                      Transition out (s)
                      <br />
                      <input
                        type="number"
                        min={0.1}
                        step={0.1}
                        value={kf.transitionOutSec}
                        onChange={(e) => scheduleTimingUpdate(kf, { transitionOutSec: Number(e.target.value) })}
                        style={{ width: 90 }}
                      />
                    </label>
                    <label className="muted">
                      Transition effect
                      <br />
                      <select
                        value={kf.transitionStyle}
                        onChange={(e) => scheduleTimingUpdate(kf, { transitionStyle: e.target.value as TransitionStyle })}
                      >
                        <option value="wipe">Head to foot</option>
                        <option value="wipe-reverse">Foot to head</option>
                        <option value="radial">Grows from within</option>
                        <option value="pixel-dissolve">Materializes gradually</option>
                        <option value="dissolve">Simple fade</option>
                      </select>
                    </label>
                  </div>

                  <div className="row" style={{ marginTop: 12 }}>
                    <button className="secondary" onClick={() => handleDelete(kf)}>
                      Remove keyframe
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="row" style={{ marginTop: 20 }}>
        <button onClick={handleExport} disabled={!allReady || exportBusy || Boolean(rendering)}>
          {exportBusy && !status ? "Starting…" : rendering ? "Rendering…" : "Generate & Export MP4"}
        </button>
        {!allReady && keyframes.length > 0 && <span className="muted">Upload an anatomy image for every keyframe to export.</span>}
      </div>

      {status && status.phase !== "error" && (
        <div style={{ marginTop: 16 }}>
          <div style={{ background: "var(--panel-2)", border: "1px solid var(--border)", borderRadius: 8, height: 10, overflow: "hidden" }}>
            <div style={{ width: `${status.percent}%`, height: "100%", background: "var(--accent-bright)", transition: "width 0.3s ease" }} />
          </div>
          <p className="muted" style={{ marginTop: 8 }}>
            {status.phase === "done" ? "Done." : `${PHASE_LABEL[status.phase]}… ${status.percent}%`}
          </p>
        </div>
      )}

      {status?.phase === "done" && status.downloadUrl && (
        <div style={{ marginTop: 16 }}>
          <video src={status.downloadUrl} controls className="frame-preview" style={{ maxHeight: 420 }} />
          <div className="row" style={{ marginTop: 12 }}>
            <a href={status.downloadUrl} download>
              <button>Download MP4</button>
            </a>
          </div>
        </div>
      )}

      {status?.phase === "error" && <div className="error-box">{status.error ?? "Export failed."}</div>}
      {error && <div className="error-box">{error}</div>}
    </div>
  );
}
