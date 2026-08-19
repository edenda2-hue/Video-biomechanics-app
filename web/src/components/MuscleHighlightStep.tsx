import { useEffect, useRef, useState } from "react";
import { generateHighlight } from "../api/client";
import type { LabelPlacement } from "../types";

export default function MuscleHighlightStep({
  sessionId,
  onReady,
  onContinue,
}: {
  sessionId: string;
  onReady: (imageUrl: string, labels: LabelPlacement[]) => void;
  onContinue: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    generateHighlight(sessionId)
      .then((r) => {
        setImageUrl(r.imageUrl);
        setLoading(false);
        onReady(r.imageUrl, r.labels);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
  }, [sessionId, onReady]);

  return (
    <div className="card">
      <h2>7. Generate Muscle Analysis</h2>
      <p className="muted">
        Selected muscles are deepened to a realistic dark-red pigmentation (fiber texture, striations and shading
        preserved — no glow or flat overlays), and muscle names are placed with leader lines using automatic
        collision-free label layout.
      </p>

      {loading && (
        <div className="spinner-line">
          <span className="dot" /> Highlighting muscles &amp; placing labels…
        </div>
      )}

      {imageUrl && <img src={imageUrl} alt="Muscle highlight" className="frame-preview" style={{ maxHeight: 460 }} />}

      {imageUrl && !loading && (
        <div className="row" style={{ marginTop: 16 }}>
          <button onClick={onContinue}>Continue to Preview</button>
        </div>
      )}

      {error && <div className="error-box">{error}</div>}
    </div>
  );
}
