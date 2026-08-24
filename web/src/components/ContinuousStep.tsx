import { useEffect, useRef, useState } from "react";
import { getContinuousExportStatus, setContinuousRange, startContinuousExport, type ExportJobStatus } from "../api/client";
import { detectPose } from "../cv/pose";
import { buildContinuousFrames, type AnatomyReference, type ContinuousProgress } from "../cv/continuousPipeline";
import { useJobPolling } from "../hooks/useJobPolling";
import type { PoseKeypoint, VideoMetadata } from "../types";

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

interface GalleryEntry {
  id: string;
  objectUrl: string;
  image: HTMLImageElement;
  pose: PoseKeypoint[];
  resolvedJoints: number;
}

/**
 * Experimental: renders the anatomy figure moving continuously through a
 * chosen range instead of freezing on one moment — the primary entry point
 * for continuous mode, independent of the single-freeze wizard steps. You
 * upload one or more anatomy reference images, each in its own pose (a
 * generic pose library — a standing figure, an overhead-arms figure, a
 * bent-over figure, whatever poses roughly cover the exercise's range of
 * motion); for every output frame the app picks whichever reference's
 * joint articulation is closest to that frame's tracked pose before
 * warping it (web/src/cv/limbWarp.ts's poseDistance/nearestPoseIndex) —
 * a single reference can only be stretched so far from its own pose before
 * a per-limb warp looks wrong. See web/src/cv/continuousPipeline.ts and the
 * README's "Continuous-motion mode" section for the full architecture.
 */
export default function ContinuousStep({ sessionId, file, metadata }: { sessionId: string; file: File; metadata: VideoMetadata }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [gallery, setGallery] = useState<GalleryEntry[]>([]);
  const [galleryBusy, setGalleryBusy] = useState(false);
  const [startSec, setStartSec] = useState(0);
  const [endSec, setEndSec] = useState(Math.min(MAX_RANGE_SEC, metadata.durationSec));
  const [prep, setPrep] = useState<ContinuousProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const { status, setStatus, error, setError, start: startPolling, stop: stopPolling } = useJobPolling(getContinuousExportStatus);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(
    () => () => {
      stopPolling();
      gallery.forEach((g) => URL.revokeObjectURL(g.objectUrl));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  async function handleAddReferences(files: FileList) {
    setGalleryBusy(true);
    setError(null);
    try {
      const added: GalleryEntry[] = [];
      for (const file of Array.from(files)) {
        const objectUrl = URL.createObjectURL(file);
        const image = await loadImage(objectUrl);
        const pose = await detectPose(image).catch(() => [] as PoseKeypoint[]);
        added.push({
          id: `${Date.now()}-${added.length}-${file.name}`,
          objectUrl,
          image,
          pose,
          resolvedJoints: pose.filter((k) => k.confidence >= 0.3).length,
        });
      }
      setGallery((g) => [...g, ...added]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGalleryBusy(false);
    }
  }

  function removeReference(id: string) {
    setGallery((g) => {
      const entry = g.find((x) => x.id === id);
      if (entry) URL.revokeObjectURL(entry.objectUrl);
      return g.filter((x) => x.id !== id);
    });
  }

  async function handleGenerate() {
    if (gallery.length === 0) {
      setError("Upload at least one anatomy reference image first.");
      return;
    }
    setBusy(true);
    setError(null);
    setStatus(null);
    setPrep(null);
    try {
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

      const targetSize = { width: metadata.width, height: metadata.height };
      const references: AnatomyReference[] = gallery.map((g) => ({
        image: g.image,
        pose: g.pose,
        size: { width: g.image.naturalWidth, height: g.image.naturalHeight },
      }));

      const frames = await buildContinuousFrames(video, references, targetSize, startSec, endSec, SAMPLE_FPS, setPrep);

      await setContinuousRange(sessionId, startSec, endSec);
      await startContinuousExport(sessionId, frames);

      setStatus({ phase: "compositing", percent: 0, message: PHASE_LABEL.compositing });
      startPolling(sessionId);
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
        The anatomy figure moves through the whole selected range — no freeze point — while the background/equipment stays locked.
        Upload one or more anatomy reference images, each in a different pose (e.g. standing, arms overhead, bent over); for every
        frame the app automatically picks whichever reference's joint angles are closest and bends it to match exactly. Runs entirely
        in your browser up to the upload step; the server re-derives the background itself, never trusting what the browser sends.
        Keep the range short (≤{MAX_RANGE_SEC}s) for now — it hasn't been tuned for longer clips yet.
      </p>

      {objectUrl && <video ref={videoRef} src={objectUrl} className="frame-preview" style={{ maxHeight: 280 }} controls muted />}

      <div style={{ marginTop: 16 }}>
        <label className="muted">
          Anatomy reference images (one or more, different poses)
          <br />
          <input
            type="file"
            accept="image/*"
            multiple
            disabled={galleryBusy}
            onChange={(e) => {
              const files = e.target.files;
              if (files && files.length > 0) handleAddReferences(files);
              e.target.value = "";
            }}
          />
        </label>
        {galleryBusy && <p className="muted">Analyzing pose…</p>}

        {gallery.length > 0 && (
          <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
            {gallery.map((g) => (
              <div key={g.id} style={{ textAlign: "center" }}>
                <img src={g.objectUrl} alt="anatomy reference" style={{ width: 100, height: 100, objectFit: "cover", borderRadius: 8, border: "1px solid var(--border)" }} />
                <p className="muted" style={{ margin: "4px 0", fontSize: 12 }}>
                  {g.resolvedJoints}/20 joints
                </p>
                <button className="secondary" onClick={() => removeReference(g.id)} style={{ fontSize: 12, padding: "2px 8px" }}>
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="row" style={{ marginTop: 16 }}>
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
        <button onClick={handleGenerate} disabled={busy || Boolean(rendering) || gallery.length === 0}>
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
