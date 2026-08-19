import { useEffect, useRef, useState } from "react";
import { getExportStatus, startExport, type ExportJobStatus } from "../api/client";

const PHASE_LABEL: Record<ExportJobStatus["phase"], string> = {
  compositing: "Compositing the anatomy transition frames",
  "encoding-segment": "Encoding the freeze segment",
  assembling: "Splicing into the original video",
  done: "Done",
  error: "Failed",
};

export default function ExportStep({ sessionId }: { sessionId: string }) {
  const [status, setStatus] = useState<ExportJobStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  async function handleExport() {
    setStarting(true);
    setError(null);
    setStatus(null);
    try {
      await startExport(sessionId);
      setStatus({ phase: "compositing", percent: 0, message: PHASE_LABEL.compositing });
      pollRef.current = setInterval(async () => {
        try {
          const s = await getExportStatus(sessionId);
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
      setStarting(false);
    }
  }

  const rendering = status && status.phase !== "done" && status.phase !== "error";

  return (
    <div className="card">
      <h2>4. Export</h2>
      <p className="muted">
        Renders the freeze segment (body-only wipe transition in, held anatomy, wipe transition back out) and splices
        it into the original video, preserving original resolution, FPS, aspect ratio and audio.
      </p>

      <div className="row">
        <button onClick={handleExport} disabled={starting || Boolean(rendering)}>
          {starting ? "Starting…" : rendering ? "Rendering…" : "Render & Export MP4"}
        </button>
      </div>

      {status && status.phase !== "error" && (
        <div style={{ marginTop: 16 }}>
          <div style={{ background: "var(--panel-2)", border: "1px solid var(--border)", borderRadius: 8, height: 10, overflow: "hidden" }}>
            <div
              style={{
                width: `${status.percent}%`,
                height: "100%",
                background: "var(--accent-bright)",
                transition: "width 0.3s ease",
              }}
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

      {status?.phase === "error" && <div className="error-box">{status.error ?? "Export failed."}</div>}
      {error && <div className="error-box">{error}</div>}
    </div>
  );
}
