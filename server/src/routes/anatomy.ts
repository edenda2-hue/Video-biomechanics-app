import fs from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import { getProvider } from "../lib/openai/index.js";
import { backgroundDiffScore } from "../lib/compositing.js";
import { computeQualityScore, poseAlignmentScore } from "../lib/quality.js";
import { requireSession, sessionDir, updateSession, HttpError } from "../lib/storage.js";
import { MAX_REGENERATE_ATTEMPTS } from "../config.js";
import type { PoseKeypoint } from "../types.js";

export const anatomyRouter = Router();

// Primary flow: the user creates the anatomical image themselves (in
// ChatGPT or any other tool) and aligns it client-side (see
// web/src/cv/alignment.ts) against the confirmed frame's pose before
// uploading the already-aligned result here. This sidesteps OpenAI image
// generation (and its cost) entirely; the /generate + /quality-check
// routes above stay available as an alternate, AI-driven path.
anatomyRouter.post("/sessions/:id/anatomy/upload", async (req, res, next) => {
  try {
    const session = requireSession(req.params.id);
    if (!session.originalFramePath) throw new HttpError(400, "Confirm a frame first");

    const imagePngBase64 = req.body?.imagePngBase64 as string | undefined;
    if (!imagePngBase64) throw new HttpError(400, "imagePngBase64 is required");
    const ignoreMask = req.body?.ignoreMask as boolean | undefined;

    const outPath = path.join(sessionDir(session.id), "anatomy_manual.png");
    await fs.writeFile(outPath, Buffer.from(imagePngBase64.replace(/^data:image\/png;base64,/, ""), "base64"));

    updateSession(session.id, { anatomyImagePath: outPath, anatomyApproved: true, ignoreMask: Boolean(ignoreMask) });
    res.json({ imageUrl: `/api/sessions/${session.id}/anatomy?ts=${Date.now()}` });
  } catch (err) {
    next(err);
  }
});

// STEP 3/4 (spec section 4): OpenAI turns the confirmed frame + mask + pose
// into the anatomical figure using the fixed anatomy instruction.
anatomyRouter.post("/sessions/:id/anatomy/generate", async (req, res, next) => {
  try {
    const session = requireSession(req.params.id);
    if (!session.originalFramePath || !session.maskPath || !session.pose) {
      throw new HttpError(400, "Frame, mask and pose must be submitted first");
    }
    if (session.attempts >= MAX_REGENERATE_ATTEMPTS) {
      throw new HttpError(409, `Maximum regeneration attempts (${MAX_REGENERATE_ATTEMPTS}) reached`);
    }

    const exerciseName = req.body?.exerciseName as string | undefined;
    const feedback = req.body?.feedback as string | undefined;
    const attempt = session.attempts + 1;
    const outPath = path.join(sessionDir(session.id), `anatomy_attempt_${attempt}.png`);

    const provider = getProvider();
    const { imagePath } = await provider.generateAnatomy({
      framePath: session.originalFramePath,
      maskPath: session.maskPath,
      pose: session.pose,
      exerciseName,
      feedback,
      outPath,
    });

    updateSession(session.id, {
      anatomyImagePath: imagePath,
      anatomyApproved: false,
      attempts: attempt,
      exerciseName: exerciseName ?? session.exerciseName,
    });

    res.json({ attempt, imageUrl: `/api/sessions/${session.id}/anatomy?ts=${Date.now()}`, provider: provider.name });
  } catch (err) {
    next(err);
  }
});

// STEP 5 (spec section 5): automatic quality gate. The frontend re-runs pose
// estimation (CV Engine) on the candidate image and posts the result here;
// the backend scores it and tells the caller whether to show it to the user
// or silently regenerate. Failed attempts are never shown to the user.
anatomyRouter.post("/sessions/:id/anatomy/quality-check", async (req, res, next) => {
  try {
    const session = requireSession(req.params.id);
    if (!session.originalFramePath || !session.maskPath || !session.pose || !session.anatomyImagePath) {
      throw new HttpError(400, "Generate an anatomy candidate first");
    }
    const candidatePose = req.body?.candidatePose as PoseKeypoint[] | undefined;
    if (!Array.isArray(candidatePose)) throw new HttpError(400, "candidatePose is required");

    const poseScore = poseAlignmentScore(session.pose, candidatePose);
    const bgScore = await backgroundDiffScore(session.originalFramePath, session.anatomyImagePath, session.maskPath);
    const quality = computeQualityScore(poseScore, bgScore);

    updateSession(session.id, { anatomyQuality: quality });

    res.json({
      quality,
      canRegenerate: session.attempts < MAX_REGENERATE_ATTEMPTS,
      attemptsUsed: session.attempts,
      maxAttempts: MAX_REGENERATE_ATTEMPTS,
    });
  } catch (err) {
    next(err);
  }
});

anatomyRouter.get("/sessions/:id/anatomy", async (req, res, next) => {
  try {
    const session = requireSession(req.params.id);
    if (!session.anatomyImagePath) throw new HttpError(404, "No anatomy image yet");
    res.sendFile(session.anatomyImagePath);
  } catch (err) {
    next(err);
  }
});

// STEP 6 (spec section 6): user's manual ORIGINAL <-> ANATOMY approval, on
// top of the automatic quality gate above.
anatomyRouter.post("/sessions/:id/anatomy/approve", (req, res) => {
  const session = requireSession(req.params.id);
  updateSession(session.id, { anatomyApproved: true });
  res.json({ anatomyApproved: true });
});
