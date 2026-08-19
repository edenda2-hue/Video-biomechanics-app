import { useState } from "react";
import ExportStep from "./components/ExportStep";
import FrameSelectStep from "./components/FrameSelectStep";
import PreviewStep from "./components/PreviewStep";
import Stepper from "./components/Stepper";
import UploadAnatomyStep from "./components/UploadAnatomyStep";
import UploadStep from "./components/UploadStep";
import type { PoseKeypoint, VideoMetadata } from "./types";

interface WizardState {
  step: number;
  sessionId?: string;
  file?: File;
  metadata?: VideoMetadata;
  freezeSec?: number;
  frameUrl?: string;
  pose?: PoseKeypoint[];
  anatomyImageUrl?: string;
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

        {state.step === 2 && state.sessionId && state.frameUrl && (
          <UploadAnatomyStep
            key={state.frameUrl}
            sessionId={state.sessionId}
            frameUrl={state.frameUrl}
            onApproved={(pose, anatomyImageUrl) => setState((s) => ({ ...s, step: 3, pose, anatomyImageUrl }))}
          />
        )}

        {state.step === 3 && state.sessionId && state.frameUrl && state.anatomyImageUrl && state.pose && (
          <PreviewStep
            sessionId={state.sessionId}
            originalFrameUrl={state.frameUrl}
            anatomyImageUrl={state.anatomyImageUrl}
            maskUrl={`/api/sessions/${state.sessionId}/mask`}
            pose={state.pose}
            initial={{ freezeDurationSec: 5, transitionInSec: 0.6, transitionOutSec: 0.6 }}
            onContinue={() => setState((s) => ({ ...s, step: 4 }))}
          />
        )}

        {state.step === 4 && state.sessionId && <ExportStep sessionId={state.sessionId} />}
      </main>
    </>
  );
}
