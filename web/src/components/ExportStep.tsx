import { useState } from "react";
import { exportVideo } from "../api/client";

export default function ExportStep({ sessionId }: { sessionId: string }) {
  const [busy, setBusy] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleExport() {
    setBusy(true);
    setError(null);
    try {
      const { downloadUrl } = await exportVideo(sessionId);
      setDownloadUrl(downloadUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>5. Export</h2>
      <p className="muted">
        Renders the freeze segment (body-only wipe transition in, held anatomy, wipe transition back out) and splices
        it into the original video, preserving original resolution, FPS, aspect ratio and audio.
      </p>

      <div className="row">
        <button onClick={handleExport} disabled={busy}>
          {busy ? "Rendering…" : "Render & Export MP4"}
        </button>
      </div>

      {busy && (
        <div className="spinner-line" style={{ marginTop: 12 }}>
          <span className="dot" /> Compositing freeze segment and encoding final video…
        </div>
      )}

      {downloadUrl && (
        <div style={{ marginTop: 16 }}>
          <video src={downloadUrl} controls className="frame-preview" style={{ maxHeight: 420 }} />
          <div className="row" style={{ marginTop: 12 }}>
            <a href={downloadUrl} download>
              <button>Download MP4</button>
            </a>
          </div>
        </div>
      )}

      {error && <div className="error-box">{error}</div>}
    </div>
  );
}
