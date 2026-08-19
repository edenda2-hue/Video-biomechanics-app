import OpenAI from "openai";
import { OPENAI_API_KEY, OPENAI_TEXT_MODEL } from "../../config.js";

export interface EditContext {
  freezeSec: number;
  freezeDurationSec: number;
  transitionInSec: number;
  transitionOutSec: number;
  trimStartSec: number;
  trimEndSec: number;
  videoDurationSec: number;
}

export interface AnatomyNudgeDelta {
  offsetXPct?: number;
  offsetYPct?: number;
  scaleDelta?: number;
  rotationDeltaDeg?: number;
}

export interface EditChanges {
  freezeDurationSec?: number;
  transitionInSec?: number;
  transitionOutSec?: number;
  trimStartSec?: number;
  trimEndSec?: number;
  freezeSec?: number;
  anatomyNudge?: AnatomyNudgeDelta;
}

export interface ChatEditResult {
  reply: string;
  changes: EditChanges;
}

export interface ChatEditProvider {
  readonly name: string;
  edit(message: string, context: EditContext): Promise<ChatEditResult>;
}

function systemPrompt(ctx: EditContext): string {
  return `You are a video-editing assistant for a single freeze-frame anatomy visualization. You can adjust exactly these parameters, nothing else:

- freezeDurationSec (seconds the freeze/anatomy hold lasts). Current: ${ctx.freezeDurationSec}
- transitionInSec / transitionOutSec (the head-to-foot wipe sweep duration in/out). Current: ${ctx.transitionInSec} / ${ctx.transitionOutSec}
- freezeSec (which moment in the source video is frozen). Current: ${ctx.freezeSec}, must stay within [trimStartSec, trimEndSec]
- trimStartSec / trimEndSec (the exported clip only covers this range of the source video, which is ${ctx.videoDurationSec.toFixed(2)}s long). Current: ${ctx.trimStartSec} / ${ctx.trimEndSec}
- anatomyNudge: a DELTA (not absolute) adjustment to the anatomy image's position/size/rotation on top of its current alignment: offsetXPct/offsetYPct (fraction of frame width/height, positive = right/down), scaleDelta (multiplicative, e.g. 1.1 = 10% bigger, 0.9 = 10% smaller), rotationDeltaDeg (degrees, positive = clockwise)

Interpret the user's request (their message may be in Hebrew or English) and respond with strict JSON only, no prose outside the JSON:
{"reply": "<short natural confirmation of what you changed, in the same language the user wrote in>", "changes": {<only the keys that should change, with their NEW absolute values, except anatomyNudge which is always a relative delta>}}

If the request is ambiguous or out of scope (anything other than the parameters listed above), leave "changes" empty ({}) and use "reply" to explain what you can help with. Never invent parameters not listed above. transitionInSec + transitionOutSec must stay less than freezeDurationSec — if a change would violate that, adjust freezeDurationSec too and mention it in the reply.`;
}

export class RealChatEditProvider implements ChatEditProvider {
  readonly name = "openai";
  private client = new OpenAI({ apiKey: OPENAI_API_KEY });

  async edit(message: string, context: EditContext): Promise<ChatEditResult> {
    const completion = await this.client.chat.completions.create({
      model: OPENAI_TEXT_MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt(context) },
        { role: "user", content: message },
      ],
    });
    const content = completion.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(content) as Partial<ChatEditResult>;
    return { reply: parsed.reply ?? "OK.", changes: parsed.changes ?? {} };
  }
}

/**
 * Offline stand-in used when OPENAI_API_KEY is unset. Handles a handful of
 * common English phrasings via regex — good enough to exercise the
 * mechanism without a key, but nowhere near as capable as the real model
 * (which also understands Hebrew, the app's actual usage language).
 */
export class MockChatEditProvider implements ChatEditProvider {
  readonly name = "mock";

  async edit(message: string, ctx: EditContext): Promise<ChatEditResult> {
    const m = message.toLowerCase();
    const changes: EditChanges = {};
    const notes: string[] = [];

    const secMatch = m.match(/(\d+(?:\.\d+)?)\s*(?:sec|second)/);
    const seconds = secMatch ? Number(secMatch[1]) : null;

    if (seconds !== null && /longer|extend|hold.*more/.test(m)) {
      changes.freezeDurationSec = ctx.freezeDurationSec + seconds;
      notes.push(`extended the hold by ${seconds}s`);
    } else if (seconds !== null && /shorter|reduce|less/.test(m)) {
      changes.freezeDurationSec = Math.max(ctx.transitionInSec + ctx.transitionOutSec + 0.2, ctx.freezeDurationSec - seconds);
      notes.push(`shortened the hold by ${seconds}s`);
    }

    if (seconds !== null && /faster|quicker|speed/.test(m)) {
      changes.transitionInSec = Math.max(0.1, ctx.transitionInSec - seconds);
      changes.transitionOutSec = Math.max(0.1, ctx.transitionOutSec - seconds);
      notes.push("made the transitions faster");
    } else if (seconds !== null && /slower/.test(m)) {
      changes.transitionInSec = ctx.transitionInSec + seconds;
      changes.transitionOutSec = ctx.transitionOutSec + seconds;
      notes.push("made the transitions slower");
    }

    const freezeAtMatch = m.match(/freeze (?:point )?(?:to|at) (\d+(?:\.\d+)?)/) ?? m.match(/move the freeze point to (\d+(?:\.\d+)?)/);
    if (freezeAtMatch) {
      changes.freezeSec = Number(freezeAtMatch[1]);
      notes.push(`moved the freeze point to ${freezeAtMatch[1]}s`);
    }

    const trimStartMatch = m.match(/trim (?:the )?start (?:to|at) (\d+(?:\.\d+)?)/) ?? m.match(/cut (?:the )?(?:beginning|start) to (\d+(?:\.\d+)?)/);
    if (trimStartMatch) {
      changes.trimStartSec = Number(trimStartMatch[1]);
      notes.push(`trimmed the start to ${trimStartMatch[1]}s`);
    }
    const trimEndMatch = m.match(/trim (?:the )?end (?:to|at) (\d+(?:\.\d+)?)/) ?? m.match(/cut (?:the )?(?:end|clip) (?:to|at) (\d+(?:\.\d+)?)/);
    if (trimEndMatch) {
      changes.trimEndSec = Number(trimEndMatch[1]);
      notes.push(`trimmed the end to ${trimEndMatch[1]}s`);
    }

    const pctMatch = m.match(/(\d+(?:\.\d+)?)\s*%/);
    const pct = (pctMatch ? Number(pctMatch[1]) : 5) / 100;
    const nudge: AnatomyNudgeDelta = {};
    if (/\bleft\b/.test(m)) nudge.offsetXPct = -pct;
    if (/\bright\b/.test(m)) nudge.offsetXPct = pct;
    if (/\bup\b|\bhigher\b/.test(m)) nudge.offsetYPct = -pct;
    if (/\bdown\b|\blower\b/.test(m)) nudge.offsetYPct = pct;
    if (/bigger|larger|enlarge/.test(m)) nudge.scaleDelta = 1 + pct;
    if (/smaller|shrink/.test(m)) nudge.scaleDelta = 1 - pct;
    if (Object.keys(nudge).length > 0) {
      changes.anatomyNudge = nudge;
      notes.push("nudged the anatomy position/size");
    }

    if (notes.length === 0) {
      return {
        reply:
          "I can adjust hold duration, transition speed, the freeze point, trim range, and the anatomy image's position/size — try something like \"hold it 2 seconds longer\" or \"move the anatomy right a bit\". (Offline demo mode has limited language understanding; connect a real OPENAI_API_KEY for full natural-language control.)",
        changes: {},
      };
    }
    return { reply: `Done — ${notes.join(", ")}.`, changes };
  }
}

let cached: ChatEditProvider | null = null;

export function getChatEditProvider(): ChatEditProvider {
  if (cached) return cached;
  cached = OPENAI_API_KEY ? new RealChatEditProvider() : new MockChatEditProvider();
  return cached;
}
