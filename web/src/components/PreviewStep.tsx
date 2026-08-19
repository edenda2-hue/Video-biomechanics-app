import { useEffect, useRef, useState } from "react";
import { setTimeline } from "../api/client";

function smoothstep(t: number) {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

export default function PreviewStep({
  sessionId,
  originalFrameUrl,
  highlightImageUrl,
  maskUrl,
  initial,
  onContinue,
}: {
  sessionId: string;
  originalFrameUrl: string;
  highlightImageUrl: string;
  maskUrl: string;
  initial: { freezeDurationSec: number; transitionInSec: number; transitionOutSec: number };
  onContinue: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const maskedLayerRef = useRef<HTMLCanvasElement | null>(null);
  const originalImgRef = useRef<HTMLImageElement | null>(null);
  const [ready, setReady] = useState(false);
  const [freezeDurationSec, setFreezeDurationSec] = useState(initial.freezeDurationSec);
  const [transitionInSec, setTransitionInSec] = useState(initial.transitionInSec);
  const [transitionOutSec, setTransitionOutSec] = useState(initial.transitionOutSec);
  const [t, setT] = useState(transitionInSec / 2);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rafRef = useRef<number | null>(null);

  // Build the "anatomy masked by person silhouette" layer once: RGB from the
  // highlight image, alpha from the segmentation mask's luminance. This is
  // the same blend the Video Engine performs server-side (lib/compositing.ts).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [original, highlight, mask] = await Promise.all([
          loadImage(originalFrameUrl),
          loadImage(highlightImageUrl),
          loadImage(maskUrl),
        ]);
        if (cancelled) return;
        originalImgRef.current = original;

        const w = original.naturalWidth;
        const h = original.naturalHeight;

        const maskCanvas = document.createElement("canvas");
        maskCanvas.width = w;
        maskCanvas.height = h;
        maskCanvas.getContext("2d")!.drawImage(mask, 0, 0, w, h);
        const maskData = maskCanvas.getContext("2d")!.getImageData(0, 0, w, h);

        const highlightCanvas = document.createElement("canvas");
        highlightCanvas.width = w;
        highlightCanvas.height = h;
        highlightCanvas.getContext("2d")!.drawImage(highlight, 0, 0, w, h);
        const highlightData = highlightCanvas.getContext("2d")!.getImageData(0, 0, w, h);

        const out = highlightCanvas.getContext("2d")!.createImageData(w, h);
        for (let p = 0; p < w * h; p++) {
          out.data[p * 4] = highlightData.data[p * 4];
          out.data[p * 4 + 1] = highlightData.data[p * 4 + 1];
          out.data[p * 4 + 2] = highlightData.data[p * 4 + 2];
          out.data[p * 4 + 3] = maskData.data[p * 4]; // luminance channel as alpha
        }

        const maskedLayer = document.createElement("canvas");
        maskedLayer.width = w;
        maskedLayer.height = h;
        maskedLayer.getContext("2d")!.putImageData(out, 0, 0);
        maskedLayerRef.current = maskedLayer;

        const canvas = canvasRef.current!;
        canvas.width = w;
        canvas.height = h;
        setReady(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [originalFrameUrl, highlightImageUrl, maskUrl]);

  function draw(currentT: number) {
    const canvas = canvasRef.current;
    const original = originalImgRef.current;
    const masked = maskedLayerRef.current;
    if (!canvas || !original || !masked) return;
    const ctx = canvas.getContext("2d")!;

    let alpha: number;
    if (currentT < transitionInSec) {
      alpha = smoothstep(currentT / (transitionInSec || 1));
    } else if (currentT < freezeDurationSec - transitionOutSec) {
      alpha = 1;
    } else {
      const outT = (currentT - (freezeDurationSec - transitionOutSec)) / (transitionOutSec || 1);
      alpha = 1 - smoothstep(outT);
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = 1;
    ctx.drawImage(original, 0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = alpha;
    ctx.drawImage(masked, 0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = 1;
  }

  useEffect(() => {
    if (ready) draw(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, t, transitionInSec, transitionOutSec, freezeDurationSec]);

  useEffect(() => {
    if (!playing) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      return;
    }
    let start: number | null = null;
    const step = (ts: number) => {
      if (start === null) start = ts;
      const elapsed = ((ts - start) / 1000) % freezeDurationSec;
      setT(elapsed);
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [playing, freezeDurationSec]);

  async function persistTimeline(patch: Partial<{ freezeDurationSec: number; transitionInSec: number; transitionOutSec: number }>) {
    try {
      await setTimeline(sessionId, patch);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="card">
      <h2>8. Preview</h2>
      <p className="muted">
        Only the human body transforms — the camera, background, equipment, and lighting never move. Scrub or play
        the freeze window to preview the body-only transition before exporting.
      </p>

      <canvas ref={canvasRef} className="frame-preview" style={{ maxHeight: 420, width: "100%" }} />

      <div className="row" style={{ marginTop: 12 }}>
        <button className="secondary" onClick={() => setPlaying((p) => !p)} disabled={!ready}>
          {playing ? "Pause" : "Play"}
        </button>
        <input
          type="range"
          min={0}
          max={freezeDurationSec}
          step={0.01}
          value={t}
          onChange={(e) => {
            setPlaying(false);
            setT(Number(e.target.value));
          }}
        />
        <span className="muted">{t.toFixed(2)}s / {freezeDurationSec.toFixed(2)}s</span>
      </div>

      <div className="row" style={{ marginTop: 16 }}>
        <label className="muted">
          Freeze duration (s)
          <br />
          <input
            type="number"
            min={1}
            step={0.5}
            value={freezeDurationSec}
            onChange={(e) => {
              const v = Number(e.target.value);
              setFreezeDurationSec(v);
              persistTimeline({ freezeDurationSec: v });
            }}
          />
        </label>
        <label className="muted">
          Transition in (s)
          <br />
          <input
            type="number"
            min={0.1}
            step={0.1}
            value={transitionInSec}
            onChange={(e) => {
              const v = Number(e.target.value);
              setTransitionInSec(v);
              persistTimeline({ transitionInSec: v });
            }}
          />
        </label>
        <label className="muted">
          Transition out (s)
          <br />
          <input
            type="number"
            min={0.1}
            step={0.1}
            value={transitionOutSec}
            onChange={(e) => {
              const v = Number(e.target.value);
              setTransitionOutSec(v);
              persistTimeline({ transitionOutSec: v });
            }}
          />
        </label>
      </div>

      <div className="row" style={{ marginTop: 16 }}>
        <button onClick={onContinue} disabled={!ready}>
          Continue to Export
        </button>
      </div>

      {error && <div className="error-box">{error}</div>}
    </div>
  );
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
