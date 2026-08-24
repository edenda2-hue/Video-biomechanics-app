import { useState } from "react";
import ContinuousStep from "./components/ContinuousStep";
import EditStep from "./components/EditStep";
import ExportStep from "./components/ExportStep";
import FrameSelectStep from "./components/FrameSelectStep";
import Stepper from "./components/Stepper";
import UploadStep from "./components/UploadStep";
import type { VideoMetadata } from "./types";

type Mode = "freeze" | "continuous";

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

export default function App() {
  const [state, setState] = useState<WizardState>({ step: 0 });

  return (
    <>
      <header className="app-header">
        <h1>Anatomical Biomechanics Video Analysis</h1>
        <p>Real movement → anatomy → muscle function → biomechanics. The original video is always the source of truth.</p>
      </header>
      <main className="app-body">
        <Stepper current={state.step} labels={state.mode === "continuous" ? CONTINUOUS_LABELS : FREEZE_LABELS} />

        {state.step === 0 && <UploadStep onUploaded={(sessionId, metadata, file) => setState({ step: 1, sessionId, metadata, file })} />}

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
                <button onClick={() => setState((s) => ({ ...s, step: 2, mode: "continuous" }))}>Continuous motion (experimental)</button>
              </div>
              <div className="card" style={{ flex: 1, margin: 0 }}>
                <h3>Single freeze point</h3>
                <p className="muted">
                  Pick one moment; the video freezes there, the anatomy figure appears, holds, then the original body returns and the
                  video resumes.
                </p>
                <button className="secondary" onClick={() => setState((s) => ({ ...s, step: 2, mode: "freeze" }))}>
                  Single freeze point
                </button>
              </div>
            </div>
          </div>
        )}

        {state.mode === "continuous" && state.step === 2 && state.sessionId && state.file && state.metadata && (
          <ContinuousStep sessionId={state.sessionId} file={state.file} metadata={state.metadata} />
        )}

        {state.mode === "freeze" && state.step === 2 && state.sessionId && state.file && state.metadata && (
          <FrameSelectStep
            sessionId={state.sessionId}
            file={state.file}
            metadata={state.metadata}
            onConfirmed={(freezeSec, frameUrl) => setState((s) => ({ ...s, step: 3, freezeSec, frameUrl }))}
          />
        )}

        {state.mode === "freeze" && state.step === 3 && state.sessionId && state.frameUrl && state.freezeSec !== undefined && state.metadata && (
          <EditStep
            key={state.sessionId}
            sessionId={state.sessionId}
            initialFrameUrl={state.frameUrl}
            initialFreezeSec={state.freezeSec}
            videoDurationSec={state.metadata.durationSec}
            onContinue={() => setState((s) => ({ ...s, step: 4 }))}
          />
        )}

        {state.mode === "freeze" && state.step === 4 && state.sessionId && <ExportStep sessionId={state.sessionId} />}
      </main>
    </>
  );
}
