// Per-frame person/background segmentation across a video time range — the
// mask-side counterpart to videoPoseTrack.ts. Continuous mode's compositing
// rule is the same body-only principle the single-freeze flow already uses
// (result = original*(1-mask*alpha) + puppet*(mask*alpha)); it just needs a
// mask *per output frame* instead of one static mask, since the person's
// silhouette moves throughout the exercise.
import { FilesetResolver, ImageSegmenter } from "@mediapipe/tasks-vision";
import { resizeMaskBuffer } from "./maskBuffer";

// See cv/segmentation.ts's MODEL_URL comment: selfie_segmenter (previously
// used here too) dropped a raised/extended arm from the mask almost
// entirely and gave shoes a uniform partial-confidence blob instead of a
// clean boundary, verified directly against a real exercise photo.
// selfie_multiclass_256x256 doesn't share that close-up-framing assumption.
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite";
const WASM_BASE = "/mediapipe-wasm";
const PERSON_CLASSES = [1, 2, 3, 4]; // hair, body-skin, face-skin, clothes (0 = background, 5 = other)

let videoSegmenterPromise: Promise<ImageSegmenter> | null = null;

function getVideoSegmenter(): Promise<ImageSegmenter> {
  if (!videoSegmenterPromise) {
    videoSegmenterPromise = FilesetResolver.forVisionTasks(WASM_BASE).then((fileset) =>
      ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL },
        runningMode: "VIDEO",
        outputCategoryMask: false,
        outputConfidenceMasks: true,
      }),
    );
  }
  return videoSegmenterPromise;
}

export interface TrackedMask {
  tSec: number;
  /** Single-channel float buffer, values in [0,1] (person confidence), at `width`x`height`. Null on a dropout frame. */
  mask: Float32Array | null;
  width: number;
  height: number;
}

/**
 * Seeks `video` through `[startSec, endSec]` at `sampleFps` and runs person
 * segmentation on each sampled frame, resizing every mask to
 * `targetWidth`x`targetHeight` (the export frame resolution) so callers can
 * composite directly without a per-frame resize step. `mask` is null for a
 * dropout frame — callers should hold the nearest neighboring frame's mask
 * rather than let the body-only guarantee lapse to "whole frame replaced."
 * Requires exclusive use of `video` (repeated seeking) and a fully loaded,
 * seekable source.
 */
export async function trackMaskAcrossVideo(
  video: HTMLVideoElement,
  startSec: number,
  endSec: number,
  sampleFps: number,
  targetWidth: number,
  targetHeight: number,
  onProgress?: (fraction: number) => void,
): Promise<TrackedMask[]> {
  if (import.meta.env.VITE_CV_MOCK === "1") return mockTrack(startSec, endSec, sampleFps, targetWidth, targetHeight);

  const segmenter = await getVideoSegmenter();
  const step = 1 / sampleFps;
  const sampleTimes: number[] = [];
  for (let t = startSec; t <= endSec + 1e-6; t += step) sampleTimes.push(Math.min(t, endSec));

  const results: TrackedMask[] = [];
  let lastTimestampMs = -1;
  for (let i = 0; i < sampleTimes.length; i++) {
    const tSec = sampleTimes[i];
    await seekTo(video, tSec);
    let timestampMs = Math.round(tSec * 1000);
    if (timestampMs <= lastTimestampMs) timestampMs = lastTimestampMs + 1;
    lastTimestampMs = timestampMs;

    const result = segmenter.segmentForVideo(video, timestampMs);
    const masks = result.confidenceMasks;
    if (!masks || masks.length <= Math.max(...PERSON_CLASSES)) {
      results.push({ tSec, mask: null, width: targetWidth, height: targetHeight });
    } else {
      const mw = masks[0].width;
      const mh = masks[0].height;
      const personArrays = PERSON_CLASSES.map((idx) => masks[idx].getAsFloat32Array());
      const raw = new Float32Array(mw * mh);
      for (let p = 0; p < raw.length; p++) {
        let person = 0;
        for (const arr of personArrays) person += arr[p];
        raw[p] = Math.min(1, person);
      }
      const resized = resizeMaskBuffer(raw, mw, mh, targetWidth, targetHeight);
      masks.forEach((m) => m.close());
      results.push({ tSec, mask: resized, width: targetWidth, height: targetHeight });
    }
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

/** Offline stand-in for VITE_CV_MOCK=1: a centered ellipse silhouette that sways in sync with videoPoseTrack's mock, so a mocked continuous-mode run has matching pose/mask motion. */
function mockTrack(
  startSec: number,
  endSec: number,
  sampleFps: number,
  targetWidth: number,
  targetHeight: number,
): TrackedMask[] {
  const step = 1 / sampleFps;
  const frames: TrackedMask[] = [];
  for (let t = startSec; t <= endSec + 1e-6; t += step) {
    const tSec = Math.min(t, endSec);
    const sway = Math.sin(tSec * 2) * 0.03;
    const mask = new Float32Array(targetWidth * targetHeight);
    const cx = (0.5 + sway) * targetWidth;
    const cy = 0.5 * targetHeight;
    const rx = 0.16 * targetWidth;
    const ry = 0.42 * targetHeight;
    for (let y = 0; y < targetHeight; y++) {
      for (let x = 0; x < targetWidth; x++) {
        const nx = (x - cx) / rx;
        const ny = (y - cy) / ry;
        mask[y * targetWidth + x] = nx * nx + ny * ny <= 1 ? 1 : 0;
      }
    }
    frames.push({ tSec, mask, width: targetWidth, height: targetHeight });
  }
  return frames;
}
