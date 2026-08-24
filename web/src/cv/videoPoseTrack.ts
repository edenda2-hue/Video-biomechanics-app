// Runs pose detection across a *range* of video frames (not just the single
// freeze frame) — the input the continuous skeletal-puppet animation needs.
// MediaPipe's tasks-vision requires a dedicated landmarker instance in
// "VIDEO" running mode (a fixed instance can't mix IMAGE and VIDEO calls),
// driven by seeking the video element frame-by-frame and calling
// detectForVideo with a strictly increasing timestamp per sample.
import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";
import type { BodyPart, PoseKeypoint } from "../types";

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task";
const WASM_BASE = "/mediapipe-wasm";

let videoLandmarkerPromise: Promise<PoseLandmarker> | null = null;

function getVideoLandmarker(): Promise<PoseLandmarker> {
  if (!videoLandmarkerPromise) {
    videoLandmarkerPromise = FilesetResolver.forVisionTasks(WASM_BASE).then((fileset) =>
      PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL },
        runningMode: "VIDEO",
        numPoses: 1,
      }),
    );
  }
  return videoLandmarkerPromise;
}

export interface TrackedFrame {
  tSec: number;
  pose: PoseKeypoint[] | null;
}

/**
 * Seeks `video` through `[startSec, endSec]` at `sampleFps` and runs pose
 * detection on each sampled frame. `pose` is null for a sample where no
 * person was confidently detected (a dropout — callers should carry the
 * nearest neighboring frame's pose forward rather than let the puppet
 * vanish). Requires exclusive use of `video` (it seeks it repeatedly) and
 * that the underlying media is fully loaded/seekable before calling.
 */
export async function trackPoseAcrossVideo(
  video: HTMLVideoElement,
  startSec: number,
  endSec: number,
  sampleFps: number,
  onProgress?: (fraction: number) => void,
): Promise<TrackedFrame[]> {
  if (import.meta.env.VITE_CV_MOCK === "1") return mockTrack(startSec, endSec, sampleFps);

  const landmarker = await getVideoLandmarker();
  const step = 1 / sampleFps;
  const sampleTimes: number[] = [];
  for (let t = startSec; t <= endSec + 1e-6; t += step) sampleTimes.push(Math.min(t, endSec));

  const results: TrackedFrame[] = [];
  let lastTimestampMs = -1;
  for (let i = 0; i < sampleTimes.length; i++) {
    const tSec = sampleTimes[i];
    await seekTo(video, tSec);
    // detectForVideo requires strictly increasing ms timestamps; video
    // seeking can land on the same decoded frame twice near clip edges.
    let timestampMs = Math.round(tSec * 1000);
    if (timestampMs <= lastTimestampMs) timestampMs = lastTimestampMs + 1;
    lastTimestampMs = timestampMs;

    const result = landmarker.detectForVideo(video, timestampMs);
    const lm = result.landmarks[0];
    results.push({ tSec, pose: lm ? toKeypoints(lm) : null });
    onProgress?.((i + 1) / sampleTimes.length);
  }
  return results;
}

function seekTo(video: HTMLVideoElement, tSec: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSeeked = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      resolve();
    };
    const onError = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      reject(new Error("Video seek failed"));
    };
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onError);
    video.currentTime = tSec;
  });
}

// Mirrors pose.ts's landmark index layout; kept in sync manually since the
// two files use separate (IMAGE vs VIDEO mode) landmarker instances.
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

function mid(a: { x: number; y: number; visibility?: number }, b: { x: number; y: number; visibility?: number }) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, visibility: Math.min(a.visibility ?? 1, b.visibility ?? 1) };
}

function toKeypoints(lm: { x: number; y: number; visibility?: number }[]): PoseKeypoint[] {
  const shoulderMid = mid(lm[LEFT_SHOULDER], lm[RIGHT_SHOULDER]);
  const hipMid = mid(lm[LEFT_HIP], lm[RIGHT_HIP]);
  const spineMid = mid(shoulderMid, hipMid);

  const entries: [BodyPart, { x: number; y: number; visibility?: number }][] = [
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

/** Deterministic offline stand-in for VITE_CV_MOCK=1: a standing pose that sways slightly over time, so downstream warp code has non-degenerate per-frame motion to work with. */
function mockTrack(startSec: number, endSec: number, sampleFps: number): TrackedFrame[] {
  const step = 1 / sampleFps;
  const frames: TrackedFrame[] = [];
  for (let t = startSec; t <= endSec + 1e-6; t += step) {
    const tSec = Math.min(t, endSec);
    const sway = Math.sin(tSec * 2) * 0.03;
    const parts: Record<BodyPart, [number, number]> = {
      head: [0.5 + sway, 0.12],
      neck: [0.5 + sway, 0.2],
      left_shoulder: [0.42 + sway, 0.24],
      right_shoulder: [0.58 + sway, 0.24],
      left_elbow: [0.35 + sway, 0.38],
      right_elbow: [0.65 + sway, 0.38],
      left_wrist: [0.3 + sway, 0.5],
      right_wrist: [0.7 + sway, 0.5],
      left_hand: [0.29 + sway, 0.52],
      right_hand: [0.71 + sway, 0.52],
      spine: [0.5 + sway, 0.35],
      pelvis: [0.5 + sway, 0.5],
      left_hip: [0.45 + sway, 0.5],
      right_hip: [0.55 + sway, 0.5],
      left_knee: [0.44 + sway, 0.68],
      right_knee: [0.56 + sway, 0.68],
      left_ankle: [0.43 + sway, 0.86],
      right_ankle: [0.57 + sway, 0.86],
      left_foot: [0.42 + sway, 0.9],
      right_foot: [0.58 + sway, 0.9],
    };
    frames.push({
      tSec,
      pose: Object.entries(parts).map(([part, [x, y]]) => ({ part: part as BodyPart, x, y, confidence: 0.95 })),
    });
  }
  return frames;
}
