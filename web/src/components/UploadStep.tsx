import { useState } from "react";
import { uploadVideo } from "../api/client";
import type { VideoMetadata } from "../types";

export default function UploadStep({
  onUploaded,
}: {
  onUploaded: (sessionId: string, metadata: VideoMetadata, file: File) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File) {
    setBusy(true);
    setError(null);
    try {
      const { id, metadata } = await uploadVideo(file);
      onUploaded(id, metadata, file);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>1. Upload Video</h2>
      <p className="muted">
        The original video is the source of truth. Resolution, FPS, aspect ratio, duration, orientation, audio and
        codec are read directly from the file and become the fixed "Master Canvas" for every later step.
      </p>
      <div className="row">
        <input
          type="file"
          accept="video/*"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
          }}
        />
        {busy && (
          <div className="spinner-line">
            <span className="dot" /> Reading video metadata…
          </div>
        )}
      </div>
      {error && <div className="error-box">{error}</div>}
    </div>
  );
}
