import path from "node:path";
import { Router } from "express";
import { buildContinuousSequence, type ContinuousFrameInput } from "../lib/continuousComposite.js";
import { assembleContinuousVideo, encodeImageSequence } from "../lib/ffmpeg.js";
import { getJob, setJob } from "../lib/exportJobs.js";
import { requireSession, sessionDir, updateSession, HttpError } from "../lib/storage.js";

export const continuousRouter = Router();

/** Namespaces continuous-mode's export job under the same in-memory job map the single-freeze flow uses, so the two never collide even for the same session. */
function jobKey(sessionId: string): string {
  return `continuous:${sessionId}`;
}

/** Sets the range the anatomy figure animates through continuously, replacing the single-freeze-point flow for this session. */
continuousRouter.put("/sessions/:id/continuous/range", (req, res, next) => {
  try {
    const session = requireSession(req.params.id);
    const { startSec, endSec } = req.body ?? {};
    if (typeof startSec !== "number" || typeof endSec !== "number" || startSec >= endSec) {
      throw new HttpError(400, "startSec and endSec are required, with startSec < endSec");
    }

    const trimEnd = session.trimEndSec ?? session.metadata?.durationSec;
    if (trimEnd === undefined) throw new HttpError(400, "Set the trim range before the continuous-mode range");
    if (startSec < session.trimStartSec || endSec > trimEnd) {
      throw new HttpError(400, "The continuous-mode range must fall within the trimmed video range");
    }

    updateSession(session.id, { continuousStartSec: startSec, continuousEndSec: endSec });
    res.json({ continuousStartSec: startSec, continuousEndSec: endSec });
  } catch (err) {
    next(err);
  }
});

/**
 * Renders continuous mode's full export: the client has already run pose
 * tracking + mask tracking + the skeletal-puppet warp for every sampled
 * frame in [continuousStartSec, continuousEndSec] (web/src/cv/
 * videoPoseTrack.ts + videoMaskTrack.ts + limbWarp.ts) and uploads the
 * per-frame results here. The server never trusts the client's background —
 * buildContinuousSequence re-extracts each frame's original pixels directly
 * from the source video before compositing, the same body-only guarantee
 * the single-freeze flow enforces. Runs as a background job, same polling
 * pattern as /export.
 */
continuousRouter.post("/sessions/:id/continuous/export", (req, res, next) => {
  try {
    const session = requireSession(req.params.id);
    const { originalVideoPath, metadata, continuousStartSec, continuousEndSec } = session;
    if (!originalVideoPath || !metadata) throw new HttpError(400, "Upload a video first");
    if (continuousStartSec === undefined || continuousEndSec === undefined) {
      throw new HttpError(400, "Set the continuous-mode range before exporting");
    }

    const frames = req.body?.frames as ContinuousFrameInput[] | undefined;
    if (!Array.isArray(frames) || frames.length === 0) throw new HttpError(400, "frames is required");
    for (const f of frames) {
      if (typeof f.tSec !== "number" || !f.puppetPngBase64 || !f.maskPngBase64) {
        throw new HttpError(400, "Each frame requires tSec, puppetPngBase64 and maskPngBase64");
      }
    }
    const sorted = [...frames].sort((a, b) => a.tSec - b.tSec);

    const key = jobKey(session.id);
    setJob(key, { phase: "compositing", percent: 0, message: "Compositing the continuous anatomy sequence…" });
    res.json({ jobId: key });

    (async () => {
      try {
        const dir = sessionDir(session.id);
        const seqDir = path.join(dir, "continuous_seq");

        await buildContinuousSequence(originalVideoPath, sorted, seqDir, (fraction) =>
          setJob(key, {
            phase: "compositing",
            percent: Math.round(fraction * 50),
            message: "Compositing the continuous anatomy sequence…",
          }),
        );

        const segmentPath = path.join(dir, "continuous_segment.mp4");
        await encodeImageSequence(path.join(seqDir, "frame_%05d.png"), metadata, segmentPath, {
          frameCount: sorted.length,
          onProgress: (fraction) =>
            setJob(key, {
              phase: "encoding-segment",
              percent: 50 + Math.round(fraction * 20),
              message: "Encoding the continuous segment…",
            }),
        });

        const trimEndSec = session.trimEndSec ?? metadata.durationSec;
        const outPath = path.join(dir, "continuous_export.mp4");
        await assembleContinuousVideo(
          {
            originalVideoPath,
            continuousSegmentPath: segmentPath,
            startSec: continuousStartSec,
            endSec: continuousEndSec,
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
          downloadUrl: `/api/sessions/${session.id}/continuous/export/file`,
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

continuousRouter.get("/sessions/:id/continuous/export/status", (req, res) => {
  const session = requireSession(req.params.id);
  const job = getJob(jobKey(session.id));
  if (!job) throw new HttpError(404, "No continuous export in progress");
  res.json(job);
});

continuousRouter.get("/sessions/:id/continuous/export/file", (req, res, next) => {
  try {
    const session = requireSession(req.params.id);
    const outPath = path.join(sessionDir(session.id), "continuous_export.mp4");
    res.download(outPath, "anatomy-analysis-continuous.mp4");
  } catch (err) {
    next(err);
  }
});
