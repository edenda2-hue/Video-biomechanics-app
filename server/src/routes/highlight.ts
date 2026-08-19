import path from "node:path";
import { Router } from "express";
import { getProvider } from "../lib/openai/index.js";
import { bakeLabels } from "../lib/compositing.js";
import { layoutLabels } from "../lib/labelLayout.js";
import { requireSession, sessionDir, updateSession, HttpError } from "../lib/storage.js";

export const highlightRouter = Router();

// STEP 8/9 (spec sections 8-9): highlight the approved primary muscles in
// deep dark red (tissue-realistic, no glow/flat overlays) and place the
// muscle-name leader lines via the deterministic Smart Label Placement.
highlightRouter.post("/sessions/:id/highlight", async (req, res, next) => {
  try {
    const session = requireSession(req.params.id);
    if (!session.anatomyImagePath || !session.maskPath || !session.pose) {
      throw new HttpError(400, "Approved anatomy image is required first");
    }
    if (!session.anatomyApproved) throw new HttpError(400, "Anatomy must be approved before highlighting muscles");
    if (session.muscles.length === 0) throw new HttpError(400, "Select at least one primary muscle first");

    const provider = getProvider();
    const highlightPath = path.join(sessionDir(session.id), "highlight.png");
    await provider.highlightMuscles({
      anatomyImagePath: session.anatomyImagePath,
      maskPath: session.maskPath,
      muscles: session.muscles,
      outPath: highlightPath,
    });

    const labels = layoutLabels(session.muscles, session.pose);
    const finalPath = path.join(sessionDir(session.id), "anatomy_final.png");
    await bakeLabels(highlightPath, labels, finalPath);

    updateSession(session.id, { highlightImagePath: finalPath, labels });
    res.json({ imageUrl: `/api/sessions/${session.id}/highlight?ts=${Date.now()}`, labels });
  } catch (err) {
    next(err);
  }
});

highlightRouter.get("/sessions/:id/highlight", async (req, res, next) => {
  try {
    const session = requireSession(req.params.id);
    if (!session.highlightImagePath) throw new HttpError(404, "No highlight image yet");
    res.sendFile(session.highlightImagePath);
  } catch (err) {
    next(err);
  }
});
