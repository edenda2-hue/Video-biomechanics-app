// Ties together the continuous-mode CV pieces (videoPoseTrack,
// videoMaskTrack, limbWarp) into the per-frame payload the server's
// /continuous/export route expects. This is the client-side half of
// continuous mode; the server never trusts any of this as the final
// background — it only uses the puppet+mask this produces, re-extracting
// the actual original frame itself before compositing.
import type { PoseKeypoint } from "../types";
import { maskBufferToPngDataUrl } from "./maskBuffer";
import { nearestPoseIndex, renderSkeletalPuppetFrameFromPoses } from "./limbWarp";
import { trackMaskAcrossVideo } from "./videoMaskTrack";
import { trackPoseAcrossVideo } from "./videoPoseTrack";

export interface AnatomyReference {
  image: HTMLImageElement;
  pose: PoseKeypoint[];
  size: { width: number; height: number };
}

export interface ContinuousFrame {
  tSec: number;
  puppetPngBase64: string;
  maskPngBase64: string;
}

export interface ContinuousProgress {
  stage: "pose" | "mask" | "render";
  fraction: number;
}

/**
 * Runs pose tracking, then mask tracking (sequentially — both seek the same
 * `video` element, so they can't run concurrently), then renders the
 * skeletal-puppet warp for every sampled frame in [startSec, endSec].
 *
 * `references` is one or more anatomy images, each in its own pose — not
 * tied to any particular video frame. A single reference can only be
 * stretched so far from its own pose before a per-limb warp looks wrong
 * (e.g. a standing reference warped toward an overhead lockout), so for
 * every output frame this picks whichever reference's *articulation*
 * (relative joint angles — see limbWarp.ts's poseDistance) is closest to
 * that frame's tracked pose, then warps that one. With a single reference
 * this reduces to the old single-image behavior.
 *
 * `targetSize` is the output resolution (normally the source video's own).
 * A frame where pose or mask detection dropped out carries the nearest
 * earlier frame's result forward rather than aborting — a momentary CV miss
 * shouldn't sink the whole range.
 */
export async function buildContinuousFrames(
  video: HTMLVideoElement,
  references: AnatomyReference[],
  targetSize: { width: number; height: number },
  startSec: number,
  endSec: number,
  sampleFps: number,
  onProgress?: (p: ContinuousProgress) => void,
): Promise<ContinuousFrame[]> {
  if (references.length === 0) throw new Error("At least one anatomy reference image is required");

  const poseFrames = await trackPoseAcrossVideo(video, startSec, endSec, sampleFps, (f) => onProgress?.({ stage: "pose", fraction: f }));
  const maskFrames = await trackMaskAcrossVideo(
    video,
    startSec,
    endSec,
    sampleFps,
    targetSize.width,
    targetSize.height,
    (f) => onProgress?.({ stage: "mask", fraction: f }),
  );
  if (poseFrames.length !== maskFrames.length) {
    throw new Error("Pose and mask tracking sampled a different number of frames — this is a bug, not a CV quality issue");
  }

  const referencePoses = references.map((r) => r.pose);
  let lastPose: PoseKeypoint[] | null = null;
  let lastMask: Float32Array | null = null;
  const frames: ContinuousFrame[] = [];

  for (let i = 0; i < poseFrames.length; i++) {
    const pose: PoseKeypoint[] | null = poseFrames[i].pose ?? lastPose;
    const mask: Float32Array | null = maskFrames[i].mask ?? lastMask;
    if (!pose) {
      throw new Error(`No person detected near t=${poseFrames[i].tSec.toFixed(2)}s — start the range where the person is clearly visible`);
    }
    if (!mask) {
      throw new Error(`No person detected (segmentation) near t=${maskFrames[i].tSec.toFixed(2)}s`);
    }
    lastPose = pose;
    lastMask = mask;

    const ref = references[nearestPoseIndex(pose, referencePoses)];
    const puppetCanvas = renderSkeletalPuppetFrameFromPoses(ref.image, ref.pose, pose, ref.size, targetSize);
    frames.push({
      tSec: poseFrames[i].tSec,
      puppetPngBase64: puppetCanvas.toDataURL("image/png"),
      maskPngBase64: maskBufferToPngDataUrl(mask, targetSize.width, targetSize.height),
    });
    onProgress?.({ stage: "render", fraction: (i + 1) / poseFrames.length });
  }

  return frames;
}
