import { QUALITY_THRESHOLDS } from "../config.js";
import type { PoseKeypoint, QualityScore } from "../types.js";

/**
 * Compares the original pose (from the source frame) against the pose
 * re-detected on the generated anatomical frame. This is the automatic
 * "Original Wrist <-> Anatomical Wrist", "Original Knee <-> Anatomical
 * Knee", etc. check from spec section 5.
 */
export function poseAlignmentScore(original: PoseKeypoint[], candidate: PoseKeypoint[]): number {
  const byPart = new Map(candidate.map((k) => [k.part, k]));
  let total = 0;
  let count = 0;
  for (const o of original) {
    const c = byPart.get(o.part);
    if (!c || c.confidence < 0.3 || o.confidence < 0.3) continue;
    const dist = Math.hypot(o.x - c.x, o.y - c.y);
    // Normalized coordinates; a joint within ~4% of frame size counts as aligned.
    const score = Math.max(0, 1 - dist / 0.12);
    total += score;
    count++;
  }
  return count === 0 ? 0 : total / count;
}

export function computeQualityScore(
  poseAlignment: number,
  backgroundConsistency: number,
): QualityScore {
  const overall = poseAlignment * 0.55 + backgroundConsistency * 0.45;
  const passed =
    poseAlignment >= QUALITY_THRESHOLDS.poseAlignment &&
    backgroundConsistency >= QUALITY_THRESHOLDS.backgroundConsistency &&
    overall >= QUALITY_THRESHOLDS.overall;

  const details = passed
    ? "Pose alignment and background consistency both within threshold."
    : [
        poseAlignment < QUALITY_THRESHOLDS.poseAlignment ? "Pose alignment below threshold." : null,
        backgroundConsistency < QUALITY_THRESHOLDS.backgroundConsistency
          ? "Background/equipment consistency below threshold."
          : null,
      ]
        .filter(Boolean)
        .join(" ");

  return { poseAlignment, backgroundConsistency, overall, passed, details };
}
