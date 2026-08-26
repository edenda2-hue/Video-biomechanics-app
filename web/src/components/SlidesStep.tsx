import { useEffect, useRef, useState } from "react";
import {
  addSlide,
  deleteSlide,
  getSlidesExportStatus,
  startSlidesExport,
  updateSlide,
  uploadSlideAnatomy,
  type ExportJobStatus,
} from "../api/client";
import { useJobPolling } from "../hooks/useJobPolling";
import type { TransitionStyle, VideoMetadata } from "../types";

const PHASE_LABEL: Record<ExportJobStatus["phase"], string> = {
  compositing: "Compositing the slide",
  "encoding-segment": "Encoding the slide segment",
  assembling: "Splicing into the original video",
  done: "Done",
  error: "Failed",
};

interface SlideEntry {
  id: string;
  timeSec: number;
  frameUrl: string;
  anatomyImageUrl: string | null;
  holdDurationSec: number;
  transitionInSec: number;
  transitionOutSec: number;
  transitionStyle: TransitionStyle;
  busy: boolean;
  error: string | null;
}

/**
 * "Anatomy Slides" mode: instead of dressing the anatomy image onto the
 * person's body (which needs pose detection, segmentation, and precise
 * manual alignment — Anatomy Keyframes/single-freeze), the anatomy image
 * swaps in as a full-frame slide, like a title card, at as many points in
 * the video as you choose. There's no body to align to, so there's nothing
 * to align: upload an image, place it in time, done. A slide at 0:00 opens
 * the video already showing the anatomy image, fading out into the real
 * footage.
 */
export default function SlidesStep({ sessionId, file, metadata }: { sessionId: string; file: File; metadata: VideoMetadata }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [pickTime, setPickTime] = useState(0);
  const [slides, setSlides] = useState<SlideEntry[]>([]);
  const [addingSlide, setAddingSlide] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const { status, setStatus, error, setError, start: startPolling, stop: stopPolling } = useJobPolling(getSlidesExportStatus);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.currentTime = pickTime;
  }, [pickTime]);

  useEffect(() => stopPolling, [stopPolling]);

  async function handleAddSlide() {
    setAddingSlide(true);
    setError(null);
    try {
      const { id, timeSec, frameUrl } = await addSlide(sessionId, pickTime);
      const url = `${frameUrl}?t=${Date.now()}`;
      setSlides((ss) =>
        [
          ...ss,
          {
            id,
            timeSec,
            frameUrl: url,
            anatomyImageUrl: null,
            holdDurationSec: 3,
            transitionInSec: 0.5,
            transitionOutSec: 0.5,
            transitionStyle: "dissolve" as const,
            busy: false,
            error: null,
          },
        ].sort((a, b) => a.timeSec - b.timeSec),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAddingSlide(false);
    }
  }

  function patchSlide(id: string, patch: Partial<SlideEntry>) {
    setSlides((ss) => ss.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }

  async function handleAnatomyFile(slide: SlideEntry, file: File) {
    patchSlide(slide.id, { busy: true, error: null });
    try {
      const dataUrl = await fileToDataUrl(file);
      const { imageUrl } = await uploadSlideAnatomy(sessionId, slide.id, dataUrl);
      patchSlide(slide.id, { busy: false, anatomyImageUrl: imageUrl });
    } catch (e) {
      patchSlide(slide.id, { busy: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // One debounce timer per slide (a Map, not a single ref) — a single
  // shared timer would let editing a second slide's timing within the
  // debounce window silently cancel the first slide's still-pending update
  // before it ever reaches the server.
  const timingDebounce = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  function scheduleTimingUpdate(
    slide: SlideEntry,
    patch: { holdDurationSec?: number; transitionInSec?: number; transitionOutSec?: number; transitionStyle?: TransitionStyle },
  ) {
    patchSlide(slide.id, patch);
    const existing = timingDebounce.current.get(slide.id);
    if (existing) clearTimeout(existing);
    timingDebounce.current.set(
      slide.id,
      setTimeout(() => {
        updateSlide(sessionId, slide.id, patch).catch((e) => patchSlide(slide.id, { error: e instanceof Error ? e.message : String(e) }));
      }, 400),
    );
  }

  async function handleDelete(slide: SlideEntry) {
    try {
      await deleteSlide(sessionId, slide.id);
      setSlides((ss) => ss.filter((s) => s.id !== slide.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleExport() {
    setExportBusy(true);
    setError(null);
    setStatus(null);
    try {
      await startSlidesExport(sessionId);
      setStatus({ phase: "compositing", percent: 0, message: PHASE_LABEL.compositing });
      startPolling(sessionId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExportBusy(false);
    }
  }

  const rendering = status && status.phase !== "done" && status.phase !== "error";
  const allReady = slides.length > 0 && slides.every((s) => s.anatomyImageUrl);

  return (
    <div className="card">
      <h2>3. Anatomy Slides</h2>
      <p className="muted">
        Swap to a full anatomy reference image at the start of the video, and/or at any point you choose — the whole frame becomes the
        anatomy image for a moment, then fades back into the real footage. No body alignment needed: pick a moment, upload an image,
        done. Add a slide at 0:00 to open the video with it.
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
        <button onClick={handleAddSlide} disabled={addingSlide}>
          {addingSlide ? "Adding…" : "+ Add Slide at this time"}
        </button>
      </div>

      {slides.length > 0 && (
        <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 16 }}>
          {slides.map((slide) => (
            <div key={slide.id} className="card" style={{ margin: 0 }}>
              <div className="row" style={{ alignItems: "flex-start", gap: 16 }}>
                <img
                  src={slide.anatomyImageUrl ?? slide.frameUrl}
                  alt="slide"
                  style={{ width: 140, borderRadius: 8, border: "1px solid var(--border)" }}
                />
                <div style={{ flex: 1 }}>
                  <p style={{ margin: "0 0 8px" }}>
                    <strong>{slide.timeSec === 0 ? "Opening slide (0:00)" : `Slide at ${slide.timeSec.toFixed(2)}s`}</strong>
                  </p>
                  <label className="muted">
                    {slide.anatomyImageUrl ? "Replace anatomy image" : "Upload anatomy image"}
                    <br />
                    <input
                      type="file"
                      accept="image/*"
                      disabled={slide.busy}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        // See KeyframesStep.tsx's identical fix: browsers
                        // fire no `change` event at all when the same file
                        // is re-selected through the native picker.
                        e.target.value = "";
                        if (f) handleAnatomyFile(slide, f);
                      }}
                    />
                  </label>
                  {slide.busy && <p className="muted">Uploading…</p>}
                  {slide.error && <div className="error-box">{slide.error}</div>}

                  <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
                    <label className="muted">
                      Hold duration (s)
                      <br />
                      <input
                        type="number"
                        min={1}
                        step={0.5}
                        value={slide.holdDurationSec}
                        onChange={(e) => scheduleTimingUpdate(slide, { holdDurationSec: Number(e.target.value) })}
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
                        value={slide.transitionInSec}
                        onChange={(e) => scheduleTimingUpdate(slide, { transitionInSec: Number(e.target.value) })}
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
                        value={slide.transitionOutSec}
                        onChange={(e) => scheduleTimingUpdate(slide, { transitionOutSec: Number(e.target.value) })}
                        style={{ width: 90 }}
                      />
                    </label>
                    <label className="muted">
                      Transition effect
                      <br />
                      <select
                        value={slide.transitionStyle}
                        onChange={(e) => scheduleTimingUpdate(slide, { transitionStyle: e.target.value as TransitionStyle })}
                      >
                        <option value="dissolve">Simple fade</option>
                        <option value="wipe">Top to bottom</option>
                        <option value="wipe-reverse">Bottom to top</option>
                        <option value="radial">Grows from center</option>
                        <option value="pixel-dissolve">Materializes gradually</option>
                      </select>
                    </label>
                  </div>

                  <div className="row" style={{ marginTop: 12 }}>
                    <button className="secondary" onClick={() => handleDelete(slide)}>
                      Remove slide
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
        {!allReady && slides.length > 0 && <span className="muted">Upload an anatomy image for every slide to export.</span>}
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

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}
