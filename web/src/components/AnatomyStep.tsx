import { useEffect, useRef, useState } from "react";
import { checkAnatomyQuality, generateAnatomy, submitPose } from "../api/client";
import { detectPose } from "../cv/pose";
import { segmentPerson } from "../cv/segmentation";
import type { PoseKeypoint, QualityScore } from "../types";

type Phase = "cv" | "generating" | "checking" | "done" | "exhausted" | "error";

export default function AnatomyStep({
  sessionId,
  frameUrl,
  onReady,
}: {
  sessionId: string;
  frameUrl: string;
  onReady: (pose: PoseKeypoint[], anatomyImageUrl: string) => void;
}) {
  const [phase, setPhase] = useState<Phase>("cv");
  const [exerciseName, setExerciseName] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [quality, setQuality] = useState<QualityScore | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [anatomyUrl, setAnatomyUrl] = useState<string | null>(null);
  const [originalPose, setOriginalPose] = useState<PoseKeypoint[] | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    runPipeline();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runPipeline(feedback?: string) {
    try {
      let pose = originalPose;
      if (!pose) {
        setPhase("cv");
        const img = await loadImage(frameUrl);
        pose = await detectPose(img);
        const maskDataUrl = await segmentPerson(img, img.naturalWidth, img.naturalHeight);
        await submitPose(sessionId, pose, maskDataUrl);
        setOriginalPose(pose);
      }

      setPhase("generating");
      const gen = await generateAnatomy(sessionId, exerciseName || undefined, feedback);
      setAttempt(gen.attempt);
      setAnatomyUrl(gen.imageUrl);

      setPhase("checking");
      const candidateImg = await loadImage(gen.imageUrl);
      const candidatePose = await detectPose(candidateImg);
      const qc = await checkAnatomyQuality(sessionId, candidatePose);
      setQuality(qc.quality);

      if (qc.quality.passed) {
        setPhase("done");
        onReady(pose, gen.imageUrl);
      } else if (qc.canRegenerate) {
        await runPipeline(qc.quality.details);
      } else {
        setPhase("exhausted");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  function forceContinue() {
    if (originalPose && anatomyUrl) onReady(originalPose, anatomyUrl);
  }

  return (
    <div className="card">
      <h2>3. Generate Anatomy</h2>
      <p className="muted">
        OpenAI replaces only the human body with an anatomical figure, aligned to the original pose. Failed
        automatic-QC attempts are regenerated silently — you only see the result that passes.
      </p>

      <div className="row" style={{ marginBottom: 16 }}>
        <input
          type="text"
          placeholder="Exercise name (optional, e.g. Front Lever)"
          value={exerciseName}
          disabled={phase !== "cv" || started.current === false}
          onChange={(e) => setExerciseName(e.target.value)}
          style={{ minWidth: 260 }}
        />
      </div>

      {phase !== "done" && phase !== "error" && phase !== "exhausted" && (
        <div className="spinner-line">
          <span className="dot" />
          {phase === "cv" && "Running pose estimation + human segmentation…"}
          {phase === "generating" && `Generating anatomical figure (attempt ${attempt || 1})…`}
          {phase === "checking" && "Checking pose alignment & background consistency…"}
        </div>
      )}

      {anatomyUrl && (phase === "done" || phase === "exhausted") && (
        <img src={anatomyUrl} alt="Generated anatomy" className="frame-preview" style={{ marginTop: 16, maxHeight: 420 }} />
      )}

      {quality && (phase === "done" || phase === "exhausted") && (
        <div className="quality-grid">
          <QualityTile label="Pose Alignment" value={quality.poseAlignment} />
          <QualityTile label="Background Consistency" value={quality.backgroundConsistency} />
          <QualityTile label="Overall" value={quality.overall} />
        </div>
      )}

      {phase === "exhausted" && (
        <>
          <div className="error-box">
            Automatic quality control did not clear the threshold after multiple attempts: {quality?.details}
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button onClick={forceContinue}>Continue with best attempt anyway</button>
          </div>
        </>
      )}

      {error && <div className="error-box">{error}</div>}
    </div>
  );
}

function QualityTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="quality-tile">
      <div className="label">{label}</div>
      <div className="value">{Math.round(value * 100)}%</div>
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
