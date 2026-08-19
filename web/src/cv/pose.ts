import { FilesetResolver, PoseLandmarker, type NormalizedLandmark } from "@mediapipe/tasks-vision";
import type { BodyPart, PoseKeypoint } from "../types";

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task";
const WASM_BASE = "/mediapipe-wasm";

// MediaPipe Pose's 33-point topology, mapped onto the spec's anatomical
// landmark list (section 3): most map 1:1, a few (neck/spine/pelvis/hands)
// are derived midpoints since MediaPipe doesn't emit them directly.
const LEFT_SHOULDER = 11;
const RIGHT_SHOULDER = 12;
const LEFT_ELBOW = 13;
const RIGHT_ELBOW = 14;
const LEFT_WRIST = 15;
const RIGHT_WRIST = 16;
const LEFT_INDEX = 19;
const RIGHT_INDEX = 20;
const LEFT_HIP = 23;
const RIGHT_HIP = 24;
const LEFT_KNEE = 25;
const RIGHT_KNEE = 26;
const LEFT_ANKLE = 27;
const RIGHT_ANKLE = 28;
const LEFT_FOOT_INDEX = 31;
const RIGHT_FOOT_INDEX = 32;
const NOSE = 0;

let landmarkerPromise: Promise<PoseLandmarker> | null = null;

function getLandmarker(): Promise<PoseLandmarker> {
  if (!landmarkerPromise) {
    landmarkerPromise = FilesetResolver.forVisionTasks(WASM_BASE).then((fileset) =>
      PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL },
        runningMode: "IMAGE",
        numPoses: 1,
      }),
    );
  }
  return landmarkerPromise;
}

export async function detectPose(image: HTMLCanvasElement | HTMLImageElement): Promise<PoseKeypoint[]> {
  if (import.meta.env.VITE_CV_MOCK === "1") return mockPose();
  const landmarker = await getLandmarker();
  const result = landmarker.detect(image);
  const lm = result.landmarks[0];
  if (!lm) throw new Error("No person detected in the selected frame");
  return toKeypoints(lm);
}

/**
 * Offline stand-in for the real MediaPipe pose model (mirrors the backend's
 * MockAnatomyProvider), used when VITE_CV_MOCK=1. Useful for local dev or
 * CI/browser testing in environments where the model CDN isn't reachable.
 */
function mockPose(): PoseKeypoint[] {
  const parts: Record<BodyPart, [number, number]> = {
    head: [0.5, 0.12],
    neck: [0.5, 0.2],
    left_shoulder: [0.42, 0.24],
    right_shoulder: [0.58, 0.24],
    left_elbow: [0.35, 0.38],
    right_elbow: [0.65, 0.38],
    left_wrist: [0.3, 0.5],
    right_wrist: [0.7, 0.5],
    left_hand: [0.29, 0.52],
    right_hand: [0.71, 0.52],
    spine: [0.5, 0.35],
    pelvis: [0.5, 0.5],
    left_hip: [0.45, 0.5],
    right_hip: [0.55, 0.5],
    left_knee: [0.44, 0.68],
    right_knee: [0.56, 0.68],
    left_ankle: [0.43, 0.86],
    right_ankle: [0.57, 0.86],
    left_foot: [0.42, 0.9],
    right_foot: [0.58, 0.9],
  };
  return Object.entries(parts).map(([part, [x, y]]) => ({ part: part as BodyPart, x, y, confidence: 0.95 }));
}

function mid(a: NormalizedLandmark, b: NormalizedLandmark) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, visibility: Math.min(a.visibility ?? 1, b.visibility ?? 1) };
}

function toKeypoints(lm: NormalizedLandmark[]): PoseKeypoint[] {
  const shoulderMid = mid(lm[LEFT_SHOULDER], lm[RIGHT_SHOULDER]);
  const hipMid = mid(lm[LEFT_HIP], lm[RIGHT_HIP]);
  const spineMid = mid(shoulderMid as NormalizedLandmark, hipMid as NormalizedLandmark);

  const entries: [BodyPart, NormalizedLandmark | ReturnType<typeof mid>][] = [
    ["head", lm[NOSE]],
    ["neck", shoulderMid],
    ["left_shoulder", lm[LEFT_SHOULDER]],
    ["right_shoulder", lm[RIGHT_SHOULDER]],
    ["left_elbow", lm[LEFT_ELBOW]],
    ["right_elbow", lm[RIGHT_ELBOW]],
    ["left_wrist", lm[LEFT_WRIST]],
    ["right_wrist", lm[RIGHT_WRIST]],
    ["left_hand", lm[LEFT_INDEX]],
    ["right_hand", lm[RIGHT_INDEX]],
    ["spine", spineMid],
    ["pelvis", hipMid],
    ["left_hip", lm[LEFT_HIP]],
    ["right_hip", lm[RIGHT_HIP]],
    ["left_knee", lm[LEFT_KNEE]],
    ["right_knee", lm[RIGHT_KNEE]],
    ["left_ankle", lm[LEFT_ANKLE]],
    ["right_ankle", lm[RIGHT_ANKLE]],
    ["left_foot", lm[LEFT_FOOT_INDEX]],
    ["right_foot", lm[RIGHT_FOOT_INDEX]],
  ];

  return entries.map(([part, p]) => ({
    part,
    x: clamp01(p.x),
    y: clamp01(p.y),
    confidence: p.visibility ?? 1,
  }));
}

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v));
}
