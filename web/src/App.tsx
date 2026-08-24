import { useState } from "react";
import ContinuousStep from "./components/ContinuousStep";
import EditStep from "./components/EditStep";
import ExportStep from "./components/ExportStep";
import FrameSelectStep from "./components/FrameSelectStep";
import Stepper from "./components/Stepper";
import UploadStep from "./components/UploadStep";
import type { VideoMetadata } from "./types";

interface WizardState {
  step: number;
  sessionId?: string;
  file?: File;
  metadata?: VideoMetadata;
  freezeSec?: number;
  frameUrl?: string;
}

export default function App() {
  const [state, setState] = useState<WizardState>({ step: 0 });

  return (
    <>
      <header className="app-header">
        <h1>Anatomical Biomechanics Video Analysis</h1>
        <p>Real movement → anatomy → muscle function → biomechanics. The original video is always the source of truth.</p>
      </header>
      <main className="app-body">
        <Stepper current={state.step} />

        {state.step === 0 && (
          <UploadStep
            onUploaded={(sessionId, metadata, file) => setState({ step: 1, sessionId, metadata, file })}
          />
        )}

        {state.step === 1 && state.sessionId && state.file && state.metadata && (
          <FrameSelectStep
            sessionId={state.sessionId}
            file={state.file}
            metadata={state.metadata}
            onConfirmed={(freezeSec, frameUrl) =>
              setState((s) => ({ ...s, step: 2, freezeSec, frameUrl }))
            }
          />
        )}

        {state.step === 2 && state.sessionId && state.frameUrl && state.freezeSec !== undefined && state.metadata && (
          <EditStep
            key={state.sessionId}
            sessionId={state.sessionId}
            initialFrameUrl={state.frameUrl}
            initialFreezeSec={state.freezeSec}
            videoDurationSec={state.metadata.durationSec}
            onContinue={() => setState((s) => ({ ...s, step: 3 }))}
          />
        )}

        {state.step === 3 && state.sessionId && <ExportStep sessionId={state.sessionId} />}
        {state.step === 3 && state.sessionId && state.file && state.metadata && (
          <ContinuousStep sessionId={state.sessionId} file={state.file} metadata={state.metadata} />
        )}
      </main>
    </>
  );
}
