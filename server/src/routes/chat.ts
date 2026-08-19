import { Router } from "express";
import { extractFrame } from "../lib/ffmpeg.js";
import { getChatEditProvider } from "../lib/openai/chatEdit.js";
import { requireSession, updateSession, HttpError } from "../lib/storage.js";

export const chatRouter = Router();

// The Edit screen's AI chat: interprets a natural-language request against
// the current timing/trim/alignment parameters and returns what changed.
// Timing/trim are applied here directly; the anatomy position/size nudge is
// returned as a delta for the client to apply (that state lives client-side
// until the aligned image is re-uploaded). If the freeze point itself
// moves, the frame is re-extracted here and the client is told to re-run
// CV + realign against it.
chatRouter.post("/sessions/:id/chat", async (req, res, next) => {
  try {
    const session = requireSession(req.params.id);
    const message = req.body?.message as string | undefined;
    if (!message || !message.trim()) throw new HttpError(400, "message is required");
    if (!session.metadata || session.freezeSec === undefined) {
      throw new HttpError(400, "Confirm a frame before using the edit chat");
    }

    const trimEndSec = session.trimEndSec ?? session.metadata.durationSec;
    const provider = getChatEditProvider();
    const result = await provider.edit(message, {
      freezeSec: session.freezeSec,
      freezeDurationSec: session.freezeDurationSec,
      transitionInSec: session.transitionInSec,
      transitionOutSec: session.transitionOutSec,
      trimStartSec: session.trimStartSec,
      trimEndSec,
      videoDurationSec: session.metadata.durationSec,
    });

    const { anatomyNudge, freezeSec: newFreezeSec, ...timelineChanges } = result.changes;
    const patch: Record<string, number> = {};
    for (const [k, v] of Object.entries(timelineChanges)) {
      if (typeof v === "number" && Number.isFinite(v)) patch[k] = v;
    }

    const nextTrimStart = patch.trimStartSec ?? session.trimStartSec;
    const nextTrimEnd = patch.trimEndSec ?? trimEndSec;
    const nextInSec = patch.transitionInSec ?? session.transitionInSec;
    const nextOutSec = patch.transitionOutSec ?? session.transitionOutSec;
    const nextDur = patch.freezeDurationSec ?? session.freezeDurationSec;
    if (nextTrimStart < 0 || nextTrimEnd > session.metadata.durationSec || nextTrimStart >= nextTrimEnd) {
      throw new HttpError(400, "Requested trim range is invalid");
    }
    if (nextInSec + nextOutSec >= nextDur) {
      throw new HttpError(400, "Requested transition timing would exceed the hold duration");
    }

    let frameChanged = false;
    let frameUrl: string | undefined;
    let effectiveFreezeSec = session.freezeSec;
    if (typeof newFreezeSec === "number" && Number.isFinite(newFreezeSec) && newFreezeSec !== session.freezeSec) {
      if (newFreezeSec < nextTrimStart || newFreezeSec > nextTrimEnd) {
        throw new HttpError(400, "Requested freeze point falls outside the trim range");
      }
      const framePath = session.originalFramePath!;
      await extractFrame(session.originalVideoPath, newFreezeSec, framePath);
      effectiveFreezeSec = newFreezeSec;
      frameChanged = true;
      frameUrl = `/api/sessions/${session.id}/frame?t=${Date.now()}`;
    }

    updateSession(session.id, { ...patch, freezeSec: effectiveFreezeSec, trimStartSec: nextTrimStart, trimEndSec: nextTrimEnd });

    res.json({
      reply: result.reply,
      provider: provider.name,
      anatomyNudge: anatomyNudge ?? null,
      frameChanged,
      frameUrl,
      timeline: {
        freezeSec: effectiveFreezeSec,
        freezeDurationSec: nextDur,
        transitionInSec: nextInSec,
        transitionOutSec: nextOutSec,
        trimStartSec: nextTrimStart,
        trimEndSec: nextTrimEnd,
      },
    });
  } catch (err) {
    next(err);
  }
});
