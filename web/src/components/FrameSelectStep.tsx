import { useEffect, useRef, useState } from "react";
import { confirmFrame } from "../api/client";
import type { VideoMetadata } from "../types";

export default function FrameSelectStep({
  sessionId,
  file,
  metadata,
  onConfirmed,
}: {
  sessionId: string;
  file: File;
  metadata: VideoMetadata;
  onConfirmed: (freezeSec: number, frameUrl: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [time, setTime] = useState(Math.min(1, metadata.durationSec / 2));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.currentTime = time;
  }, [time]);

  async function handleConfirm() {
    setBusy(true);
    setError(null);
    try {
      const { freezeSec, frameUrl } = await confirmFrame(sessionId, time);
      onConfirmed(freezeSec, `${frameUrl}?t=${Date.now()}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>3. Select Frame</h2>
      <p className="muted">Scrub the timeline to the exact moment you want to analyze, then confirm the frame.</p>
      {objectUrl && (
        <video
          ref={videoRef}
          src={objectUrl}
          className="frame-preview"
          style={{ maxHeight: 360 }}
          controls={false}
          muted
        />
      )}
      <div className="row" style={{ marginTop: 12 }}>
        <input
          type="range"
          min={0}
          max={metadata.durationSec}
          step={1 / metadata.fps}
          value={time}
          onChange={(e) => setTime(Number(e.target.value))}
        />
        <input
          type="number"
          min={0}
          max={metadata.durationSec}
          step={1 / metadata.fps}
          value={time.toFixed(2)}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) setTime(Math.min(metadata.durationSec, Math.max(0, v)));
          }}
          style={{ width: 90 }}
        />
        <span className="muted">seconds / {metadata.durationSec.toFixed(2)}s total</span>
      </div>
      <div className="row" style={{ marginTop: 16 }}>
        <button onClick={handleConfirm} disabled={busy}>
          {busy ? "Extracting…" : "CONFIRM FRAME"}
        </button>
      </div>
      {error && <div className="error-box">{error}</div>}
    </div>
  );
}
