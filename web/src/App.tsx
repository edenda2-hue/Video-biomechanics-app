import { useState } from "react";
import AnatomyStep from "./components/AnatomyStep";
import ApproveAnatomyStep from "./components/ApproveAnatomyStep";
import ExportStep from "./components/ExportStep";
import FrameSelectStep from "./components/FrameSelectStep";
import MovementAnalysisStep from "./components/MovementAnalysisStep";
import MuscleHighlightStep from "./components/MuscleHighlightStep";
import PreviewStep from "./components/PreviewStep";
import Stepper from "./components/Stepper";
import UploadStep from "./components/UploadStep";
import type { LabelPlacement, MuscleSuggestion, PoseKeypoint, VideoMetadata } from "./types";

interface WizardState {
  step: number;
  sessionId?: string;
  file?: File;
  metadata?: VideoMetadata;
  freezeSec?: number;
  frameUrl?: string;
  pose?: PoseKeypoint[];
  anatomyImageUrl?: string;
  exerciseName?: string;
  muscles?: MuscleSuggestion[];
  highlightImageUrl?: string;
  labels?: LabelPlacement[];
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
          <AnatomyStep
            key={state.frameUrl}
            sessionId={state.sessionId}
            frameUrl={state.frameUrl}
            onReady={(pose, anatomyImageUrl) => setState((s) => ({ ...s, step: 3, pose, anatomyImageUrl }))}
          />
        )}

        {state.step === 3 && state.sessionId && state.frameUrl && state.anatomyImageUrl && (
          <ApproveAnatomyStep
            sessionId={state.sessionId}
            originalFrameUrl={state.frameUrl}
            anatomyImageUrl={state.anatomyImageUrl}
            onApproved={() => setState((s) => ({ ...s, step: 4 }))}
            onRegenerate={() => setState((s) => ({ ...s, step: 2, anatomyImageUrl: undefined }))}
          />
        )}

        {state.step === 4 && state.sessionId && (
          <MovementAnalysisStep
            sessionId={state.sessionId}
            exerciseName={state.exerciseName}
            onConfirmed={(muscles) => setState((s) => ({ ...s, step: 5, muscles }))}
          />
        )}

        {state.step === 5 && state.sessionId && (
          <MuscleHighlightStep
            key={state.sessionId + (state.muscles?.length ?? 0)}
            sessionId={state.sessionId}
            onReady={(highlightImageUrl, labels) => setState((s) => ({ ...s, highlightImageUrl, labels }))}
            onContinue={() => setState((s) => ({ ...s, step: 6 }))}
          />
        )}

        {state.step === 6 && state.sessionId && state.frameUrl && state.highlightImageUrl && (
          <PreviewStep
            sessionId={state.sessionId}
            originalFrameUrl={state.frameUrl}
            highlightImageUrl={state.highlightImageUrl}
            maskUrl={`/api/sessions/${state.sessionId}/mask`}
            initial={{ freezeDurationSec: 5, transitionInSec: 0.6, transitionOutSec: 0.6 }}
            onContinue={() => setState((s) => ({ ...s, step: 7 }))}
          />
        )}

        {state.step === 7 && state.sessionId && <ExportStep sessionId={state.sessionId} />}
      </main>
    </>
  );
}
