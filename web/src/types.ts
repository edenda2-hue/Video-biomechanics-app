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
  anchor: { x: number; y: number };
  source: "ai" | "user";
}

export interface QualityScore {
  poseAlignment: number;
  backgroundConsistency: number;
  overall: number;
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
  metadata?: VideoMetadata;
  freezeSec?: number;
  freezeDurationSec: number;
  transitionInSec: number;
  transitionOutSec: number;
  exerciseName?: string;
  pose?: PoseKeypoint[];
  anatomyQuality?: QualityScore;
  anatomyApproved: boolean;
  muscles: MuscleSuggestion[];
  labels: LabelPlacement[];
  attempts: number;
}
