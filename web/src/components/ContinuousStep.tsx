import { useEffect, useRef, useState } from "react";
import {
  getContinuousExportStatus,
  getSession,
  setContinuousRange,
  startContinuousExport,
  type ExportJobStatus,
} from "../api/client";
import { buildContinuousFrames, type ContinuousProgress } from "../cv/continuousPipeline";
import type { VideoMetadata } from "../types";

const PHASE_LABEL: Record<ExportJobStatus["phase"], string> = {
  compositing: "Compositing the continuous anatomy sequence",
  "encoding-segment": "Encoding the continuous segment",
  assembling: "Splicing into the original video",
  done: "Done",
  error: "Failed",
};

const SAMPLE_FPS = 12;
const MAX_RANGE_SEC = 6; // keeps a first run's client-side CV pass and payload size manageable

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
    img.src = src;
  });
}

/**
 * Experimental: renders the anatomy figure moving continuously through a
 * chosen range instead of a single freeze. Runs entirely client-side up to
 * the point of uploading a per-frame puppet+mask sequence — see
 * web/src/cv/continuousPipeline.ts and the README's "Continuous-motion
 * mode" section for the full architecture.
 */
export default function ContinuousStep({ sessionId, file, metadata }: { sessionId: string; file: File; metadata: VideoMetadata }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [startSec, setStartSec] = useState(0);
  const [endSec, setEndSec] = useState(Math.min(MAX_RANGE_SEC, metadata.durationSec));
  const [prep, setPrep] = useState<ContinuousProgress | null>(null);
  const [status, setStatus] = useState<ExportJobStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  async function handleGenerate() {
    setBusy(true);
    setError(null);
    setStatus(null);
    setPrep(null);
    try {
      const session = await getSession(sessionId);
      if (!session.pose || session.pose.length === 0) {
        throw new Error("Complete the Edit step (align the anatomy image) before using continuous mode.");
      }
      if (!videoRef.current) throw new Error("Video not ready");
      const video = videoRef.current;
      // Only metadata (duration/dimensions, readyState >= HAVE_METADATA) is
      // needed before the pose/mask trackers start seeking frame by frame —
      // waiting for more (e.g. "loadeddata") can hang indefinitely since the
      // browser won't buffer actual frame data until something seeks or plays.
      // Skipped entirely under VITE_CV_MOCK=1: mock tracking never reads the
      // video element, so there's nothing to wait for.
      if (import.meta.env.VITE_CV_MOCK !== "1" && video.readyState < 1) {
        await new Promise<void>((resolve, reject) => {
          const onReady = () => {
            video.removeEventListener("loadedmetadata", onReady);
            video.removeEventListener("error", onErr);
            resolve();
          };
          const onErr = () => reject(new Error("Failed to load video"));
          video.addEventListener("loadedmetadata", onReady);
          video.addEventListener("error", onErr);
        });
      }

      const refImage = await loadImage(`/api/sessions/${sessionId}/anatomy?t=${Date.now()}`);
      const refSize = { width: metadata.width, height: metadata.height };

      const frames = await buildContinuousFrames(
        video,
        refImage,
        session.pose,
        refSize,
        refSize,
        startSec,
        endSec,
        SAMPLE_FPS,
        setPrep,
      );

      await setContinuousRange(sessionId, startSec, endSec);
      await startContinuousExport(sessionId, frames);

      setStatus({ phase: "compositing", percent: 0, message: PHASE_LABEL.compositing });
      pollRef.current = setInterval(async () => {
        try {
          const s = await getContinuousExportStatus(sessionId);
          setStatus(s);
          if (s.phase === "done" || s.phase === "error") {
            if (pollRef.current) clearInterval(pollRef.current);
          }
        } catch (e) {
          if (pollRef.current) clearInterval(pollRef.current);
          setError(e instanceof Error ? e.message : String(e));
        }
      }, 800);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const rendering = status && status.phase !== "done" && status.phase !== "error";
  const prepPercent = prep ? Math.round(((prep.stage === "pose" ? 0 : prep.stage === "mask" ? 1 : 2) + prep.fraction) * (100 / 3)) : 0;
  const prepLabel = prep
    ? { pose: "Tracking pose across the range…", mask: "Tracking the person's silhouette across the range…", render: "Warping the anatomy figure per frame…" }[prep.stage]
    : "";

  return (
    <div className="card">
      <h2>Continuous mode (experimental)</h2>
      <p className="muted">
        Instead of freezing on one moment, the anatomy figure moves through the whole selected range while the background/equipment
        stays locked, matching the reference clips this mode is being built to match. Runs entirely in your browser up to the upload
        step; the server re-derives the background itself, never trusting what the browser sends. Keep the range short (≤{MAX_RANGE_SEC}s)
        for now — it hasn't been tuned for longer clips yet.
      </p>

      {objectUrl && <video ref={videoRef} src={objectUrl} className="frame-preview" style={{ maxHeight: 280 }} controls muted />}

      <div className="row" style={{ marginTop: 12 }}>
        <label>
          Start (s):{" "}
          <input
            type="number"
            min={0}
            max={metadata.durationSec}
            step={0.1}
            value={startSec.toFixed(2)}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v)) setStartSec(Math.max(0, Math.min(v, endSec - 0.5)));
            }}
            style={{ width: 90 }}
          />
        </label>
        <label>
          End (s):{" "}
          <input
            type="number"
            min={0}
            max={metadata.durationSec}
            step={0.1}
            value={endSec.toFixed(2)}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v)) setEndSec(Math.min(metadata.durationSec, Math.max(v, startSec + 0.5)));
            }}
            style={{ width: 90 }}
          />
        </label>
        <span className="muted">/ {metadata.durationSec.toFixed(2)}s total</span>
      </div>

      <div className="row" style={{ marginTop: 16 }}>
        <button onClick={handleGenerate} disabled={busy || Boolean(rendering)}>
          {busy && !status ? "Preparing…" : rendering ? "Rendering…" : "Generate Continuous Video"}
        </button>
      </div>

      {busy && !status && prep && (
        <div style={{ marginTop: 16 }}>
          <div style={{ background: "var(--panel-2)", border: "1px solid var(--border)", borderRadius: 8, height: 10, overflow: "hidden" }}>
            <div style={{ width: `${prepPercent}%`, height: "100%", background: "var(--accent-bright)", transition: "width 0.3s ease" }} />
          </div>
          <p className="muted" style={{ marginTop: 8 }}>
            {prepLabel} {prepPercent}%
          </p>
        </div>
      )}

      {status && status.phase !== "error" && (
        <div style={{ marginTop: 16 }}>
          <div style={{ background: "var(--panel-2)", border: "1px solid var(--border)", borderRadius: 8, height: 10, overflow: "hidden" }}>
            <div
              style={{ width: `${status.percent}%`, height: "100%", background: "var(--accent-bright)", transition: "width 0.3s ease" }}
            />
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

      {status?.phase === "error" && <div className="error-box">{status.error ?? "Continuous export failed."}</div>}
      {error && <div className="error-box">{error}</div>}
    </div>
  );
}
