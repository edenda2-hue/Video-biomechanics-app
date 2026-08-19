import { useRef, useState } from "react";
import { approveAnatomy } from "../api/client";

export default function ApproveAnatomyStep({
  sessionId,
  originalFrameUrl,
  anatomyImageUrl,
  onApproved,
  onRegenerate,
}: {
  sessionId: string;
  originalFrameUrl: string;
  anatomyImageUrl: string;
  onApproved: () => void;
  onRegenerate: () => void;
}) {
  const [percent, setPercent] = useState(50);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  function updateFromEvent(clientX: number) {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const pct = ((clientX - rect.left) / rect.width) * 100;
    setPercent(Math.min(100, Math.max(0, pct)));
  }

  async function handleApprove() {
    setBusy(true);
    try {
      await approveAnatomy(sessionId);
      onApproved();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>4. Approve Anatomy</h2>
      <p className="muted">Drag the slider to compare ORIGINAL ↔ ANATOMY, then approve or regenerate.</p>

      <div
        ref={wrapRef}
        className="compare-wrap"
        onMouseDown={(e) => {
          dragging.current = true;
          updateFromEvent(e.clientX);
        }}
        onMouseMove={(e) => dragging.current && updateFromEvent(e.clientX)}
        onMouseUp={() => (dragging.current = false)}
        onMouseLeave={() => (dragging.current = false)}
      >
        <img src={originalFrameUrl} alt="Original" draggable={false} />
        <img
          src={anatomyImageUrl}
          alt="Anatomy"
          draggable={false}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            clipPath: `inset(0 ${100 - percent}% 0 0)`,
          }}
        />
        <div className="compare-handle" style={{ left: `${percent}%` }} />
      </div>

      <div className="row" style={{ marginTop: 16 }}>
        <button onClick={handleApprove} disabled={busy}>
          APPROVE ANATOMY
        </button>
        <button className="secondary" onClick={onRegenerate} disabled={busy}>
          REGENERATE
        </button>
      </div>
    </div>
  );
}
