import { nanoid } from "nanoid";
import { Router } from "express";
import { getProvider } from "../lib/openai/index.js";
import { requireSession, updateSession, HttpError } from "../lib/storage.js";
import type { MuscleSuggestion } from "../types.js";

export const musclesRouter = Router();

// STEP 7 (spec section 7): OpenAI proposes agonist/synergist/stabilizer muscles.
musclesRouter.post("/sessions/:id/muscles/analyze", async (req, res, next) => {
  try {
    const session = requireSession(req.params.id);
    if (!session.originalFramePath || !session.pose) throw new HttpError(400, "Frame and pose required first");

    const exerciseName = (req.body?.exerciseName as string | undefined) ?? session.exerciseName;
    const provider = getProvider();
    const suggestions = await provider.analyzeMuscles({ framePath: session.originalFramePath, pose: session.pose, exerciseName });

    const muscles: MuscleSuggestion[] = suggestions.map((m) => ({ ...m, id: nanoid(8), source: "ai" }));
    updateSession(session.id, { muscles, exerciseName });

    res.json({ muscles });
  } catch (err) {
    next(err);
  }
});

// User stays in control: APPROVE / REMOVE / ADD / REPLACE the AI's suggestions.
musclesRouter.put("/sessions/:id/muscles", (req, res, next) => {
  try {
    const session = requireSession(req.params.id);
    const muscles = req.body?.muscles as MuscleSuggestion[] | undefined;
    if (!Array.isArray(muscles)) throw new HttpError(400, "muscles must be an array");

    const normalized = muscles.map((m) => ({
      id: m.id || nanoid(8),
      name: m.name,
      role: m.role,
      anchor: m.anchor,
      source: m.source === "ai" ? "ai" : "user",
    })) as MuscleSuggestion[];

    updateSession(session.id, { muscles: normalized });
    res.json({ muscles: normalized });
  } catch (err) {
    next(err);
  }
});
