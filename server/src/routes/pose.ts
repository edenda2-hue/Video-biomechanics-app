import fs from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import { requireSession, sessionDir, updateSession, HttpError } from "../lib/storage.js";
import type { PoseKeypoint } from "../types.js";

export const poseRouter = Router();

/**
 * STEP 3 (spec section 3): Pose Estimation + Human Segmentation.
 * Runs client-side (CV Engine, see web/src/cv) and is uploaded here so the
 * backend can store the source-of-truth keypoints/mask used by every later
 * step (generation prompt, quality gate, label anchors).
 */
poseRouter.post("/sessions/:id/pose", async (req, res, next) => {
  try {
    const session = requireSession(req.params.id);
    if (!session.originalFramePath) throw new HttpError(400, "Confirm a frame before submitting pose/segmentation");

    const pose = req.body?.pose as PoseKeypoint[] | undefined;
    const maskPngBase64 = req.body?.maskPngBase64 as string | undefined;
    if (!Array.isArray(pose) || pose.length === 0) throw new HttpError(400, "pose is required");
    if (!maskPngBase64) throw new HttpError(400, "maskPngBase64 is required");

    const maskPath = path.join(sessionDir(session.id), "mask.png");
    await fs.writeFile(maskPath, Buffer.from(maskPngBase64.replace(/^data:image\/png;base64,/, ""), "base64"));

    updateSession(session.id, { pose, maskPath });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

poseRouter.get("/sessions/:id/mask", async (req, res, next) => {
  try {
    const session = requireSession(req.params.id);
    if (!session.maskPath) throw new HttpError(404, "No mask uploaded yet");
    res.sendFile(session.maskPath);
  } catch (err) {
    next(err);
  }
});
