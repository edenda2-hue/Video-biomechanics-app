import { useState } from "react";
import ContinuousStep from "./components/ContinuousStep";
import EditStep from "./components/EditStep";
import ExportStep from "./components/ExportStep";
import FrameSelectStep from "./components/FrameSelectStep";
import KeyframesStep from "./components/KeyframesStep";
import SlidesStep from "./components/SlidesStep";
import Stepper from "./components/Stepper";
import UploadStep from "./components/UploadStep";
import type { VideoMetadata } from "./types";

type Mode = "freeze" | "continuous" | "keyframes" | "slides";

interface WizardState {
  step: number;
  mode?: Mode;
  sessionId?: string;
  file?: File;
  metadata?: VideoMetadata;
  freezeSec?: number;
  frameUrl?: string;
}

const FREEZE_LABELS = ["Upload", "Mode", "Select Frame", "Edit", "Export"];
const CONTINUOUS_LABELS = ["Upload", "Mode", "Continuous"];
const KEYFRAMES_LABELS = ["Upload", "Mode", "Keyframes"];
const SLIDES_LABELS = ["Upload", "Mode", "Slides"];

export default function App() {
  const [state, setState] = useState<WizardState>({ step: 0 });
  // Every step forward pushes the previous state here first, so "Back" can
  // restore it exactly (including sessionId/file/mode) rather than just
  // decrementing a step counter and losing branch-specific fields.
  const [history, setHistory] = useState<WizardState[]>([]);

  function advance(next: WizardState) {
    setHistory((h) => [...h, state]);
    setState(next);
  }

  function goBack() {
    setHistory((h) => {
      if (h.length === 0) return h;
      setState(h[h.length - 1]);
      return h.slice(0, -1);
    });
  }

  return (
    <>
      <header className="app-header">
        <h1>Anatomical Biomechanics Video Analysis</h1>
        <p>Real movement → anatomy → muscle function → biomechanics. The original video is always the source of truth.</p>
      </header>
      <main className="app-body">
        <div className="row" style={{ marginBottom: 12, alignItems: "center" }}>
          <Stepper
            current={state.step}
            labels={
              state.mode === "continuous"
                ? CONTINUOUS_LABELS
                : state.mode === "keyframes"
                  ? KEYFRAMES_LABELS
                  : state.mode === "slides"
                    ? SLIDES_LABELS
                    : FREEZE_LABELS
            }
          />
          {history.length > 0 && (
            <button className="secondary" onClick={goBack}>
              ← Back
            </button>
          )}
        </div>

        {state.step === 0 && <UploadStep onUploaded={(sessionId, metadata, file) => advance({ step: 1, sessionId, metadata, file })} />}

        {state.step === 1 && (
          <div className="card">
            <h2>2. Mode</h2>
            <p className="muted">
              Pick how the anatomy figure should appear in the exported video.
            </p>
            <div className="row" style={{ marginTop: 16, gap: 16 }}>
              <div className="card" style={{ flex: 1, margin: 0 }}>
                <h3>Continuous motion</h3>
                <p className="muted">
                  The anatomy figure moves through the whole exercise — the person is never frozen. Upload one or more anatomy
                  reference images (different poses); the app matches and bends the closest one to every frame.
                </p>
                <button onClick={() => advance({ ...state, step: 2, mode: "continuous" })}>Continuous motion (experimental)</button>
              </div>
              <div className="card" style={{ flex: 1, margin: 0 }}>
                <h3>Anatomy Keyframes</h3>
                <p className="muted">
                  Pick as many moments as you want; each freezes with the body swapped to anatomy (head excluded — the real person's
                  face always shows). Download each frame and generate a precise anatomy image for it yourself for maximum accuracy.
                </p>
                <button onClick={() => advance({ ...state, step: 2, mode: "keyframes" })}>Anatomy Keyframes</button>
              </div>
              <div className="card" style={{ flex: 1, margin: 0 }}>
                <h3>Single freeze point</h3>
                <p className="muted">
                  Pick one moment; the video freezes there, the anatomy figure appears, holds, then the original body returns and the
                  video resumes.
                </p>
                <button className="secondary" onClick={() => advance({ ...state, step: 2, mode: "freeze" })}>
                  Single freeze point
                </button>
              </div>
              <div className="card" style={{ flex: 1, margin: 0 }}>
                <h3>Anatomy Slides</h3>
                <p className="muted">
                  No body alignment at all: the whole frame swaps to a full anatomy reference image at the start and/or at any points
                  you choose, fading smoothly in and out of the real footage — like a title card, not dressed onto the person.
                </p>
                <button className="secondary" onClick={() => advance({ ...state, step: 2, mode: "slides" })}>
                  Anatomy Slides
                </button>
              </div>
            </div>
          </div>
        )}

        {state.mode === "continuous" && state.step === 2 && state.sessionId && state.file && state.metadata && (
          <ContinuousStep sessionId={state.sessionId} file={state.file} metadata={state.metadata} />
        )}

        {state.mode === "keyframes" && state.step === 2 && state.sessionId && state.file && state.metadata && (
          <KeyframesStep sessionId={state.sessionId} file={state.file} metadata={state.metadata} />
        )}

        {state.mode === "slides" && state.step === 2 && state.sessionId && state.file && state.metadata && (
          <SlidesStep sessionId={state.sessionId} file={state.file} metadata={state.metadata} />
        )}

        {state.mode === "freeze" && state.step === 2 && state.sessionId && state.file && state.metadata && (
          <FrameSelectStep
            sessionId={state.sessionId}
            file={state.file}
            metadata={state.metadata}
            onConfirmed={(freezeSec, frameUrl) => advance({ ...state, step: 3, freezeSec, frameUrl })}
          />
        )}

        {state.mode === "freeze" && state.step === 3 && state.sessionId && state.frameUrl && state.freezeSec !== undefined && state.metadata && (
          <EditStep
            key={state.sessionId}
            sessionId={state.sessionId}
            initialFrameUrl={state.frameUrl}
            initialFreezeSec={state.freezeSec}
            videoDurationSec={state.metadata.durationSec}
            onContinue={() => advance({ ...state, step: 4 })}
          />
        )}

        {state.mode === "freeze" && state.step === 4 && state.sessionId && <ExportStep sessionId={state.sessionId} />}
      </main>
    </>
  );
}
