import path from "node:path";
import { Router } from "express";
import { buildFreezeSequence } from "../lib/compositing.js";
import { assembleFinalVideo, encodeImageSequence } from "../lib/ffmpeg.js";
import { requireSession, sessionDir, updateSession, HttpError } from "../lib/storage.js";

export const exportRouter = Router();

// STEP 14 (spec section 14): Preview lets the user tune freeze point/duration
// and transition timing before committing to a render.
exportRouter.put("/sessions/:id/timeline", (req, res, next) => {
  try {
    const session = requireSession(req.params.id);
    const { freezeDurationSec, transitionInSec, transitionOutSec } = req.body ?? {};
    const patch: Record<string, number> = {};
    if (freezeDurationSec !== undefined) patch.freezeDurationSec = Number(freezeDurationSec);
    if (transitionInSec !== undefined) patch.transitionInSec = Number(transitionInSec);
    if (transitionOutSec !== undefined) patch.transitionOutSec = Number(transitionOutSec);

    const inSec = patch.transitionInSec ?? session.transitionInSec;
    const outSec = patch.transitionOutSec ?? session.transitionOutSec;
    const dur = patch.freezeDurationSec ?? session.freezeDurationSec;
    if (inSec + outSec >= dur) throw new HttpError(400, "transitionInSec + transitionOutSec must be less than freezeDurationSec");

    updateSession(session.id, patch);
    res.json({ freezeDurationSec: dur, transitionInSec: inSec, transitionOutSec: outSec });
  } catch (err) {
    next(err);
  }
});

// STEP 9 (spec section 9-13, 15): render the freeze segment (body-only
// transition, held highlighted anatomy, transition back) and splice it into
// the original video, preserving original resolution/fps/aspect/audio.
exportRouter.post("/sessions/:id/export", async (req, res, next) => {
  try {
    const session = requireSession(req.params.id);
    const {
      originalVideoPath,
      originalFramePath,
      maskPath,
      highlightImagePath,
      metadata,
      freezeSec,
      freezeDurationSec,
      transitionInSec,
      transitionOutSec,
    } = session;

    if (!originalFramePath || !maskPath || !highlightImagePath || !metadata || freezeSec === undefined) {
      throw new HttpError(400, "Approve anatomy and generate the muscle highlight before exporting");
    }

    const dir = sessionDir(session.id);
    const seqDir = path.join(dir, "freeze_seq");
    const holdSec = freezeDurationSec - transitionInSec - transitionOutSec;

    const { width, height } = await buildFreezeSequence({
      originalFramePath,
      maskPath,
      anatomyImagePath: highlightImagePath,
      fps: metadata.fps,
      transitionInSec,
      holdSec,
      transitionOutSec,
      outDir: seqDir,
    });

    const freezeSegmentPath = path.join(dir, "freeze_segment.mp4");
    await encodeImageSequence(path.join(seqDir, "frame_%05d.png"), metadata.fps, freezeSegmentPath);

    const outPath = path.join(dir, "export.mp4");
    await assembleFinalVideo({
      originalVideoPath,
      freezeSegmentPath,
      freezeSec,
      freezeDurationSec,
      metadata,
      outPath,
    });

    updateSession(session.id, {});
    res.json({
      downloadUrl: `/api/sessions/${session.id}/export/file`,
      frameSize: { width, height },
      durationSec: metadata.durationSec + freezeDurationSec,
    });
  } catch (err) {
    next(err);
  }
});

exportRouter.get("/sessions/:id/export/file", (req, res, next) => {
  try {
    const session = requireSession(req.params.id);
    const outPath = path.join(sessionDir(session.id), "export.mp4");
    res.download(outPath, "anatomy-analysis.mp4");
  } catch (err) {
    next(err);
  }
});
