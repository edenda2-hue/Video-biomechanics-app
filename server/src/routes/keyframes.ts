import fs from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import { nanoid } from "nanoid";
import { buildFreezeSequence, radialCenterFromPose, verticalBoundsFromPose } from "../lib/compositing.js";
import { assembleMultiFreezeVideo, encodeImageSequence, extractFrame, type MultiFreezeKeyframeSegment } from "../lib/ffmpeg.js";
import { getJob, setJob } from "../lib/exportJobs.js";
import { releaseMemory } from "../lib/memory.js";
import { requireSession, sessionDir, updateSession, HttpError } from "../lib/storage.js";
import { TRANSITION_STYLES, type Keyframe, type PoseKeypoint, type TransitionStyle } from "../types.js";

export const keyframesRouter = Router();

/** Namespaces this mode's export job so it never collides with the single-freeze or continuous-mode jobs for the same session. */
function jobKey(sessionId: string): string {
  return `keyframes:${sessionId}`;
}

function findKeyframe(keyframes: Keyframe[], kfId: string): Keyframe {
  const kf = keyframes.find((k) => k.id === kfId);
  if (!kf) throw new HttpError(404, `Unknown keyframe: ${kfId}`);
  return kf;
}

/**
 * "Anatomy Keyframes" mode: as many freeze points as you choose, each
 * anchored to a real extracted frame you can download and feed into an
 * external image generator (ChatGPT/Sora/etc.) for maximum precision, then
 * upload back — the same external-generation workflow the app was
 * originally built around, generalized from one point to N. Every
 * keyframe's swap excludes the head (see compositing.ts's
 * excludeHeadFromMask), so the real person's head/face always shows
 * through.
 */
keyframesRouter.post("/sessions/:id/keyframes", async (req, res, next) => {
  try {
    const session = requireSession(req.params.id);
    if (!session.originalVideoPath || !session.metadata) throw new HttpError(400, "Upload a video first");

    const timeSec = Number(req.body?.timeSec);
    if (!Number.isFinite(timeSec) || timeSec < 0) throw new HttpError(400, "timeSec must be a non-negative number");
    if (timeSec > session.metadata.durationSec) throw new HttpError(400, "timeSec exceeds video duration");

    const id = nanoid(10);
    const framePath = path.join(sessionDir(session.id), `keyframe_${id}.png`);
    await extractFrame(session.originalVideoPath, timeSec, framePath);

    const keyframe: Keyframe = {
      id,
      timeSec,
      framePath,
      holdDurationSec: 3,
      transitionInSec: 0.4,
      transitionOutSec: 0.4,
      transitionStyle: "wipe",
    };
    updateSession(session.id, { keyframes: [...session.keyframes, keyframe] });

    res.json({ id, timeSec, frameUrl: `/api/sessions/${session.id}/keyframes/${id}/frame` });
  } catch (err) {
    next(err);
  }
});

keyframesRouter.get("/sessions/:id/keyframes", (req, res) => {
  const session = requireSession(req.params.id);
  res.json({ keyframes: session.keyframes });
});

keyframesRouter.get("/sessions/:id/keyframes/:kfId/frame", (req, res, next) => {
  try {
    const session = requireSession(req.params.id);
    const kf = findKeyframe(session.keyframes, req.params.kfId);
    if (!kf.framePath) throw new HttpError(404, "No frame extracted for this keyframe");
    res.sendFile(kf.framePath);
  } catch (err) {
    next(err);
  }
});

/** Submits pose + segmentation mask for a keyframe's frame (client-side CV Engine, same as the single-freeze /pose route). */
keyframesRouter.post("/sessions/:id/keyframes/:kfId/pose", async (req, res, next) => {
  try {
    const session = requireSession(req.params.id);
    const kf = findKeyframe(session.keyframes, req.params.kfId);

    const pose = req.body?.pose as PoseKeypoint[] | undefined;
    const maskPngBase64 = req.body?.maskPngBase64 as string | undefined;
    if (!Array.isArray(pose) || pose.length === 0) throw new HttpError(400, "pose is required");
    if (!maskPngBase64) throw new HttpError(400, "maskPngBase64 is required");

    const maskPath = path.join(sessionDir(session.id), `keyframe_${kf.id}_mask.png`);
    await fs.writeFile(maskPath, Buffer.from(maskPngBase64.replace(/^data:image\/png;base64,/, ""), "base64"));

    updateSession(session.id, {
      keyframes: session.keyframes.map((k) => (k.id === kf.id ? { ...k, pose, maskPath } : k)),
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** Uploads the (already client-aligned, or raw) anatomy image generated for this exact keyframe's frame. */
keyframesRouter.post("/sessions/:id/keyframes/:kfId/anatomy", async (req, res, next) => {
  try {
    const session = requireSession(req.params.id);
    const kf = findKeyframe(session.keyframes, req.params.kfId);

    const imagePngBase64 = req.body?.imagePngBase64 as string | undefined;
    if (!imagePngBase64) throw new HttpError(400, "imagePngBase64 is required");

    const anatomyImagePath = path.join(sessionDir(session.id), `keyframe_${kf.id}_anatomy.png`);
    await fs.writeFile(anatomyImagePath, Buffer.from(imagePngBase64.replace(/^data:image\/png;base64,/, ""), "base64"));

    updateSession(session.id, {
      keyframes: session.keyframes.map((k) => (k.id === kf.id ? { ...k, anatomyImagePath } : k)),
    });
    res.json({ imageUrl: `/api/sessions/${session.id}/keyframes/${kf.id}/anatomy?ts=${Date.now()}` });
  } catch (err) {
    next(err);
  }
});

keyframesRouter.get("/sessions/:id/keyframes/:kfId/anatomy", (req, res, next) => {
  try {
    const session = requireSession(req.params.id);
    const kf = findKeyframe(session.keyframes, req.params.kfId);
    if (!kf.anatomyImagePath) throw new HttpError(404, "No anatomy image uploaded for this keyframe yet");
    res.sendFile(kf.anatomyImagePath);
  } catch (err) {
    next(err);
  }
});

/** Tunes a keyframe's own hold duration / transition speed / timestamp — freely editable up until export. */
keyframesRouter.put("/sessions/:id/keyframes/:kfId", (req, res, next) => {
  try {
    const session = requireSession(req.params.id);
    const kf = findKeyframe(session.keyframes, req.params.kfId);

    const patch: Partial<Keyframe> = {};
    if (req.body?.holdDurationSec !== undefined) patch.holdDurationSec = Number(req.body.holdDurationSec);
    if (req.body?.transitionInSec !== undefined) patch.transitionInSec = Number(req.body.transitionInSec);
    if (req.body?.transitionOutSec !== undefined) patch.transitionOutSec = Number(req.body.transitionOutSec);
    if (req.body?.transitionStyle !== undefined) {
      if (!TRANSITION_STYLES.includes(req.body.transitionStyle)) {
        throw new HttpError(400, `transitionStyle must be one of: ${TRANSITION_STYLES.join(", ")}`);
      }
      patch.transitionStyle = req.body.transitionStyle as TransitionStyle;
    }

    const holdDurationSec = patch.holdDurationSec ?? kf.holdDurationSec;
    const transitionInSec = patch.transitionInSec ?? kf.transitionInSec;
    const transitionOutSec = patch.transitionOutSec ?? kf.transitionOutSec;
    if (transitionInSec + transitionOutSec >= holdDurationSec) {
      throw new HttpError(400, "transitionInSec + transitionOutSec must be less than holdDurationSec");
    }

    updateSession(session.id, {
      keyframes: session.keyframes.map((k) => (k.id === kf.id ? { ...k, ...patch } : k)),
    });
    res.json({ ...kf, ...patch });
  } catch (err) {
    next(err);
  }
});

keyframesRouter.delete("/sessions/:id/keyframes/:kfId", (req, res, next) => {
  try {
    const session = requireSession(req.params.id);
    findKeyframe(session.keyframes, req.params.kfId); // 404s if missing
    updateSession(session.id, { keyframes: session.keyframes.filter((k) => k.id !== req.params.kfId) });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * Renders every keyframe's freeze segment (body-only, head excluded) and
 * splices all of them into the original video at their own timestamps.
 * Runs as a background job, same async-job/polling pattern as the other
 * two modes' export routes.
 */
keyframesRouter.post("/sessions/:id/keyframes/export", (req, res, next) => {
  try {
    const session = requireSession(req.params.id);
    const { originalVideoPath, metadata } = session;
    if (!originalVideoPath || !metadata) throw new HttpError(400, "Upload a video first");

    const trimEndSec = session.trimEndSec ?? metadata.durationSec;
    const sorted = [...session.keyframes].sort((a, b) => a.timeSec - b.timeSec);
    if (sorted.length === 0) throw new HttpError(400, "Add at least one keyframe before exporting");
    for (const kf of sorted) {
      if (!kf.framePath || !kf.maskPath || !kf.pose || !kf.anatomyImagePath) {
        throw new HttpError(400, `Keyframe at ${kf.timeSec}s is missing pose/mask/anatomy — finish editing it before exporting`);
      }
      if (kf.timeSec < session.trimStartSec || kf.timeSec > trimEndSec) {
        throw new HttpError(400, `Keyframe at ${kf.timeSec}s falls outside the trimmed range`);
      }
    }

    const key = jobKey(session.id);
    setJob(key, { phase: "compositing", percent: 0, message: "Compositing keyframe 1…" });
    res.json({ jobId: key });

    (async () => {
      try {
        const dir = sessionDir(session.id);
        const segments: MultiFreezeKeyframeSegment[] = [];

        for (let i = 0; i < sorted.length; i++) {
          const kf = sorted[i];
          const seqDir = path.join(dir, `keyframe_${kf.id}_seq`);
          const holdSec = kf.holdDurationSec - kf.transitionInSec - kf.transitionOutSec;

          await buildFreezeSequence(
            {
              originalFramePath: kf.framePath!,
              maskPath: kf.maskPath!,
              anatomyImagePath: kf.anatomyImagePath!,
              fps: metadata.fps,
              transitionInSec: kf.transitionInSec,
              holdSec,
              transitionOutSec: kf.transitionOutSec,
              outDir: seqDir,
              style: kf.transitionStyle,
              verticalBounds: verticalBoundsFromPose(kf.pose!),
              radialCenter: radialCenterFromPose(kf.pose!),
              excludeHeadPose: kf.pose,
            },
            (fraction) =>
              setJob(key, {
                phase: "compositing",
                percent: Math.round(((i + fraction) / sorted.length) * 50),
                message: `Compositing keyframe ${i + 1} of ${sorted.length}…`,
              }),
          );

          // Compositing for this keyframe is done; release its raw-image
          // buffers before ffmpeg spawns and needs its own headroom.
          releaseMemory();

          const segmentPath = path.join(dir, `keyframe_${kf.id}_segment.mp4`);
          const expectedSeqFrames = Math.round(metadata.fps * kf.holdDurationSec);
          await encodeImageSequence(path.join(seqDir, "frame_%05d.png"), metadata, segmentPath, {
            frameCount: expectedSeqFrames,
            onProgress: (fraction) =>
              setJob(key, {
                phase: "encoding-segment",
                percent: 50 + Math.round(((i + fraction) / sorted.length) * 20),
                message: `Encoding keyframe ${i + 1} of ${sorted.length}…`,
              }),
          });

          segments.push({ timeSec: kf.timeSec, segmentPath, holdDurationSec: kf.holdDurationSec });
          // Each keyframe allocates several full-resolution raw-image
          // buffers; on the free tier's tight memory ceiling, waiting on
          // V8's own GC heuristics before starting the next keyframe risks
          // peak usage growing across keyframes instead of staying flat.
          releaseMemory();
        }

        const outPath = path.join(dir, "keyframes_export.mp4");
        await assembleMultiFreezeVideo(
          {
            originalVideoPath,
            keyframes: segments,
            trimStartSec: session.trimStartSec,
            trimEndSec,
            metadata,
            outPath,
          },
          (fraction) =>
            setJob(key, {
              phase: "assembling",
              percent: 70 + Math.round(fraction * 30),
              message: "Splicing into the original video…",
            }),
        );

        setJob(key, {
          phase: "done",
          percent: 100,
          message: "Done.",
          downloadUrl: `/api/sessions/${session.id}/keyframes/export/file`,
        });
      } catch (err) {
        console.error(err);
        setJob(key, {
          phase: "error",
          percent: 0,
          message: "Export failed.",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  } catch (err) {
    next(err);
  }
});

keyframesRouter.get("/sessions/:id/keyframes/export/status", (req, res) => {
  const session = requireSession(req.params.id);
  const job = getJob(jobKey(session.id));
  if (!job) throw new HttpError(404, "No keyframes export in progress");
  res.json(job);
});

keyframesRouter.get("/sessions/:id/keyframes/export/file", (req, res, next) => {
  try {
    const session = requireSession(req.params.id);
    const outPath = path.join(sessionDir(session.id), "keyframes_export.mp4");
    res.download(outPath, "anatomy-analysis-keyframes.mp4");
  } catch (err) {
    next(err);
  }
});
