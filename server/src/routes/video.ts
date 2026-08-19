import fs from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import { uploadVideo } from "../middleware/upload.js";
import { probe, extractFrame } from "../lib/ffmpeg.js";
import { createSession, requireSession, sessionDir, updateSession, HttpError } from "../lib/storage.js";

export const videoRouter = Router();

// STEP 1 (spec section 1): upload preserves all source-of-truth metadata; the
// original resolution/aspect ratio becomes the immutable "Master Canvas".
videoRouter.post("/sessions", uploadVideo.single("video"), async (req, res, next) => {
  try {
    if (!req.file) throw new HttpError(400, "Missing 'video' file");
    const session = await createSession("");
    const dir = sessionDir(session.id);
    const dest = path.join(dir, `original${path.extname(req.file.originalname) || ".mp4"}`);
    await fs.rename(req.file.path, dest);

    const metadata = await probe(dest);
    updateSession(session.id, { originalVideoPath: dest, metadata });

    res.json({ id: session.id, metadata });
  } catch (err) {
    next(err);
  }
});

videoRouter.get("/sessions/:id", (req, res) => {
  const s = requireSession(req.params.id);
  res.json(s);
});

// STEP 2 (spec section 2): extract the exact frame at the chosen timestamp
// directly from the source video (never synthesized) and hold it for CONFIRM FRAME.
videoRouter.post("/sessions/:id/frame", async (req, res, next) => {
  try {
    const session = requireSession(req.params.id);
    const timeSec = Number(req.body?.timeSec);
    if (!Number.isFinite(timeSec) || timeSec < 0) throw new HttpError(400, "timeSec must be a non-negative number");
    if (session.metadata && timeSec > session.metadata.durationSec) {
      throw new HttpError(400, "timeSec exceeds video duration");
    }

    const framePath = path.join(sessionDir(session.id), "frame_original.png");
    await extractFrame(session.originalVideoPath, timeSec, framePath);
    updateSession(session.id, { freezeSec: timeSec, originalFramePath: framePath });

    res.json({ freezeSec: timeSec, frameUrl: `/api/sessions/${session.id}/frame` });
  } catch (err) {
    next(err);
  }
});

videoRouter.get("/sessions/:id/frame", async (req, res, next) => {
  try {
    const session = requireSession(req.params.id);
    if (!session.originalFramePath) throw new HttpError(404, "No frame extracted yet");
    res.sendFile(session.originalFramePath);
  } catch (err) {
    next(err);
  }
});
