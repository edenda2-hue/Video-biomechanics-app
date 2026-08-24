// Domain types shared across the backend. Mirrored (loosely) on the frontend
// in web/src/types.ts since the two packages don't share a build step.

export const BODY_PARTS = [
  "head",
  "neck",
  "left_shoulder",
  "right_shoulder",
  "left_elbow",
  "right_elbow",
  "left_wrist",
  "right_wrist",
  "left_hand",
  "right_hand",
  "spine",
  "pelvis",
  "left_hip",
  "right_hip",
  "left_knee",
  "right_knee",
  "left_ankle",
  "right_ankle",
  "left_foot",
  "right_foot",
] as const;

export type BodyPart = (typeof BODY_PARTS)[number];

export interface PoseKeypoint {
  part: BodyPart;
  /** Normalized [0,1] coordinates relative to the frame, origin top-left. */
  x: number;
  y: number;
  confidence: number;
}

export interface VideoMetadata {
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  hasAudio: boolean;
  codec: string;
  orientation: "landscape" | "portrait" | "square";
}

export type MuscleRole = "agonist" | "synergist" | "stabilizer";

export interface MuscleSuggestion {
  id: string;
  name: string;
  role: MuscleRole;
  /** Anatomical anchor point used for the leader line, normalized [0,1]. */
  anchor: { x: number; y: number };
  source: "ai" | "user";
}

export interface QualityScore {
  poseAlignment: number; // 0-1
  backgroundConsistency: number; // 0-1
  overall: number; // 0-1
  passed: boolean;
  details: string;
}

export interface LabelPlacement {
  muscleId: string;
  name: string;
  anchor: { x: number; y: number };
  labelPos: { x: number; y: number };
  leaderPath: { x: number; y: number }[];
}

export interface Session {
  id: string;
  createdAt: number;
  originalVideoPath: string;
  metadata?: VideoMetadata;
  freezeSec?: number;
  freezeDurationSec: number;
  transitionInSec: number;
  transitionOutSec: number;
  /** Export trims the source video to [trimStartSec, trimEndSec] before splicing in the freeze. */
  trimStartSec: number;
  trimEndSec?: number;
  /**
   * Continuous mode: the anatomy figure moves through this whole range
   * (instead of a single freeze) via server/src/lib/continuousComposite.ts.
   * Must fall within [trimStartSec, trimEndSec]. Reuses `pose` and
   * `anatomyImagePath` as the reference pose/image the puppet is rigged
   * from, since the uploaded anatomy image is already warped to align with
   * the frame `pose` was detected on.
   */
  continuousStartSec?: number;
  continuousEndSec?: number;
  exerciseName?: string;
  originalFramePath?: string;
  maskPath?: string;
  pose?: PoseKeypoint[];
  anatomyImagePath?: string;
  anatomyQuality?: QualityScore;
  anatomyApproved: boolean;
  muscles: MuscleSuggestion[];
  highlightImagePath?: string;
  labels: LabelPlacement[];
  attempts: number;
}
