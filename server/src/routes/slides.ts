import fs from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import { nanoid } from "nanoid";
import sharp from "sharp";
import { buildFreezeSequence } from "../lib/compositing.js";
import { assembleMultiFreezeVideo, encodeImageSequence, extractFrame, type MultiFreezeKeyframeSegment } from "../lib/ffmpeg.js";
import { getJob, setJob } from "../lib/exportJobs.js";
import { releaseMemory } from "../lib/memory.js";
import { requireSession, sessionDir, updateSession, HttpError } from "../lib/storage.js";
import { TRANSITION_STYLES, type Slide, type TransitionStyle } from "../types.js";

export const slidesRouter = Router();

/** Namespaces this mode's export job so it never collides with the other modes' jobs for the same session. */
function jobKey(sessionId: string): string {
  return `slides:${sessionId}`;
}

function findSlide(slides: Slide[], slideId: string): Slide {
  const s = slides.find((s) => s.id === slideId);
  if (!s) throw new HttpError(404, `Unknown slide: ${slideId}`);
  return s;
}

/**
 * "Anatomy Slides" mode: instead of dressing the anatomy image onto the
 * person's body (Anatomy Keyframes/single-freeze, which needs pose
 * detection, person segmentation, and precise manual alignment), the
 * anatomy image swaps in as a full-frame slide — a title/reference card —
 * at as many points as you choose, with a smooth crossfade/sweep
 * transition in and out. There's no body to align to, so there's nothing
 * to get wrong: upload the image and place it in time, nothing more. A
 * slide at timeSec 0 opens the video already showing the anatomy image,
 * transitioning out into the real footage.
 */
slidesRouter.post("/sessions/:id/slides", async (req, res, next) => {
  try {
    const session = requireSession(req.params.id);
    if (!session.originalVideoPath || !session.metadata) throw new HttpError(400, "Upload a video first");

    const timeSec = Number(req.body?.timeSec);
    if (!Number.isFinite(timeSec) || timeSec < 0) throw new HttpError(400, "timeSec must be a non-negative number");
    if (timeSec > session.metadata.durationSec) throw new HttpError(400, "timeSec exceeds video duration");

    const id = nanoid(10);
    const framePath = path.join(sessionDir(session.id), `slide_${id}.png`);
    await extractFrame(session.originalVideoPath, timeSec, framePath);

    const slide: Slide = {
      id,
      timeSec,
      framePath,
      holdDurationSec: 3,
      transitionInSec: 0.5,
      transitionOutSec: 0.5,
      transitionStyle: "dissolve",
    };
    updateSession(session.id, { slides: [...session.slides, slide] });

    res.json({ id, timeSec, frameUrl: `/api/sessions/${session.id}/slides/${id}/frame` });
  } catch (err) {
    next(err);
  }
});

slidesRouter.get("/sessions/:id/slides", (req, res) => {
  const session = requireSession(req.params.id);
  res.json({ slides: session.slides });
});

slidesRouter.get("/sessions/:id/slides/:slideId/frame", (req, res, next) => {
  try {
    const session = requireSession(req.params.id);
    const slide = findSlide(session.slides, req.params.slideId);
    if (!slide.framePath) throw new HttpError(404, "No frame extracted for this slide");
    res.sendFile(slide.framePath);
  } catch (err) {
    next(err);
  }
});

/** Uploads the anatomy image for this slide — used as-is, full-frame, never reshaped or aligned to a body. */
slidesRouter.post("/sessions/:id/slides/:slideId/anatomy", async (req, res, next) => {
  try {
    const session = requireSession(req.params.id);
    const slide = findSlide(session.slides, req.params.slideId);

    const imagePngBase64 = req.body?.imagePngBase64 as string | undefined;
    if (!imagePngBase64) throw new HttpError(400, "imagePngBase64 is required");

    const anatomyImagePath = path.join(sessionDir(session.id), `slide_${slide.id}_anatomy.png`);
    await fs.writeFile(anatomyImagePath, Buffer.from(imagePngBase64.replace(/^data:image\/(png|jpeg);base64,/, ""), "base64"));

    updateSession(session.id, {
      slides: session.slides.map((s) => (s.id === slide.id ? { ...s, anatomyImagePath } : s)),
    });
    res.json({ imageUrl: `/api/sessions/${session.id}/slides/${slide.id}/anatomy?ts=${Date.now()}` });
  } catch (err) {
    next(err);
  }
});

slidesRouter.get("/sessions/:id/slides/:slideId/anatomy", (req, res, next) => {
  try {
    const session = requireSession(req.params.id);
    const slide = findSlide(session.slides, req.params.slideId);
    if (!slide.anatomyImagePath) throw new HttpError(404, "No anatomy image uploaded for this slide yet");
    res.sendFile(slide.anatomyImagePath);
  } catch (err) {
    next(err);
  }
});

/** Tunes a slide's own hold duration / transition speed / timestamp — freely editable up until export. */
slidesRouter.put("/sessions/:id/slides/:slideId", (req, res, next) => {
  try {
    const session = requireSession(req.params.id);
    const slide = findSlide(session.slides, req.params.slideId);

    const patch: Partial<Slide> = {};
    if (req.body?.holdDurationSec !== undefined) patch.holdDurationSec = Number(req.body.holdDurationSec);
    if (req.body?.transitionInSec !== undefined) patch.transitionInSec = Number(req.body.transitionInSec);
    if (req.body?.transitionOutSec !== undefined) patch.transitionOutSec = Number(req.body.transitionOutSec);
    if (req.body?.transitionStyle !== undefined) {
      if (!TRANSITION_STYLES.includes(req.body.transitionStyle)) {
        throw new HttpError(400, `transitionStyle must be one of: ${TRANSITION_STYLES.join(", ")}`);
      }
      patch.transitionStyle = req.body.transitionStyle as TransitionStyle;
    }

    const holdDurationSec = patch.holdDurationSec ?? slide.holdDurationSec;
    const transitionInSec = patch.transitionInSec ?? slide.transitionInSec;
    const transitionOutSec = patch.transitionOutSec ?? slide.transitionOutSec;
    if (transitionInSec + transitionOutSec >= holdDurationSec) {
      throw new HttpError(400, "transitionInSec + transitionOutSec must be less than holdDurationSec");
    }

    updateSession(session.id, {
      slides: session.slides.map((s) => (s.id === slide.id ? { ...s, ...patch } : s)),
    });
    res.json({ ...slide, ...patch });
  } catch (err) {
    next(err);
  }
});

slidesRouter.delete("/sessions/:id/slides/:slideId", (req, res, next) => {
  try {
    const session = requireSession(req.params.id);
    findSlide(session.slides, req.params.slideId); // 404s if missing
    updateSession(session.id, { slides: session.slides.filter((s) => s.id !== req.params.slideId) });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** A fully opaque (255 everywhere) greyscale mask, same dimensions as the frame — buildFreezeSequence composites within the mask, and a full-frame slide swap has no body region to confine itself to. */
async function fullFrameMaskPath(dir: string, width: number, height: number): Promise<string> {
  const maskPath = path.join(dir, `_fullframe_mask_${width}x${height}.png`);
  await sharp({ create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .png()
    .toFile(maskPath);
  return maskPath;
}

/** Fits the raw anatomy image to the frame's exact dimensions (cropping to fill, never distorting the aspect ratio) — there's no body pose to align to, so this is the only "fit" a slide needs. */
async function fitAnatomyToFrame(anatomyImagePath: string, dir: string, slideId: string, width: number, height: number): Promise<string> {
  const outPath = path.join(dir, `slide_${slideId}_anatomy_fit.png`);
  await sharp(anatomyImagePath).resize(width, height, { fit: "cover", position: "attention" }).png().toFile(outPath);
  return outPath;
}

/**
 * Renders every slide's full-frame freeze segment and splices all of them
 * into the original video at their own timestamps. Runs as a background
 * job, same async-job/polling pattern as the other modes' export routes.
 */
slidesRouter.post("/sessions/:id/slides/export", (req, res, next) => {
  try {
    const session = requireSession(req.params.id);
    const { originalVideoPath, metadata } = session;
    if (!originalVideoPath || !metadata) throw new HttpError(400, "Upload a video first");

    const trimEndSec = session.trimEndSec ?? metadata.durationSec;
    const sorted = [...session.slides].sort((a, b) => a.timeSec - b.timeSec);
    if (sorted.length === 0) throw new HttpError(400, "Add at least one slide before exporting");
    for (const s of sorted) {
      if (!s.framePath || !s.anatomyImagePath) {
        throw new HttpError(400, `Slide at ${s.timeSec}s is missing an anatomy image — finish editing it before exporting`);
      }
      if (s.timeSec < session.trimStartSec || s.timeSec > trimEndSec) {
        throw new HttpError(400, `Slide at ${s.timeSec}s falls outside the trimmed range`);
      }
    }

    const key = jobKey(session.id);
    setJob(key, { phase: "compositing", percent: 0, message: "Compositing slide 1…" });
    res.json({ jobId: key });

    (async () => {
      try {
        const dir = sessionDir(session.id);
        const segments: MultiFreezeKeyframeSegment[] = [];

        for (let i = 0; i < sorted.length; i++) {
          const s = sorted[i];
          const seqDir = path.join(dir, `slide_${s.id}_seq`);
          const holdSec = s.holdDurationSec - s.transitionInSec - s.transitionOutSec;

          const { width, height } = await sharp(s.framePath!).metadata();
          if (!width || !height) throw new Error("Could not read slide frame dimensions");
          const maskPath = await fullFrameMaskPath(dir, width, height);
          const fittedAnatomyPath = await fitAnatomyToFrame(s.anatomyImagePath!, dir, s.id, width, height);

          await buildFreezeSequence(
            {
              originalFramePath: s.framePath!,
              maskPath,
              anatomyImagePath: fittedAnatomyPath,
              fps: metadata.fps,
              transitionInSec: s.transitionInSec,
              holdSec,
              transitionOutSec: s.transitionOutSec,
              outDir: seqDir,
              style: s.transitionStyle,
              // No excludeHeadPose: a slide swaps the entire frame, not just
              // the body — there's no "real person's head" to preserve.
            },
            (fraction) =>
              setJob(key, {
                phase: "compositing",
                percent: Math.round(((i + fraction) / sorted.length) * 50),
                message: `Compositing slide ${i + 1} of ${sorted.length}…`,
              }),
          );

          releaseMemory();

          const segmentPath = path.join(dir, `slide_${s.id}_segment.mp4`);
          const expectedSeqFrames = Math.round(metadata.fps * s.holdDurationSec);
          await encodeImageSequence(path.join(seqDir, "frame_%05d.png"), metadata, segmentPath, {
            frameCount: expectedSeqFrames,
            onProgress: (fraction) =>
              setJob(key, {
                phase: "encoding-segment",
                percent: 50 + Math.round(((i + fraction) / sorted.length) * 20),
                message: `Encoding slide ${i + 1} of ${sorted.length}…`,
              }),
          });

          segments.push({ timeSec: s.timeSec, segmentPath, holdDurationSec: s.holdDurationSec });
          releaseMemory();
        }

        const outPath = path.join(dir, "slides_export.mp4");
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
          downloadUrl: `/api/sessions/${session.id}/slides/export/file`,
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

slidesRouter.get("/sessions/:id/slides/export/status", (req, res) => {
  const session = requireSession(req.params.id);
  const job = getJob(jobKey(session.id));
  if (!job) throw new HttpError(404, "No slides export in progress");
  res.json(job);
});

slidesRouter.get("/sessions/:id/slides/export/file", (req, res, next) => {
  try {
    const session = requireSession(req.params.id);
    const outPath = path.join(sessionDir(session.id), "slides_export.mp4");
    res.download(outPath, "anatomy-analysis-slides.mp4");
  } catch (err) {
    next(err);
  }
});
