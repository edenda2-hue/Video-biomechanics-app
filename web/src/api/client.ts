import type { LabelPlacement, MuscleSuggestion, PoseKeypoint, QualityScore, Session, VideoMetadata } from "../types";

const BASE = "/api";

async function handle<T>(resp: Response): Promise<T> {
  if (!resp.ok) {
    const body = await resp.text();
    let message = body;
    try {
      message = JSON.parse(body).error ?? body;
    } catch {
      // not JSON, use raw text
    }
    throw new Error(message || `Request failed: ${resp.status}`);
  }
  return resp.json() as Promise<T>;
}

export async function uploadVideo(file: File): Promise<{ id: string; metadata: VideoMetadata }> {
  const form = new FormData();
  form.append("video", file);
  const resp = await fetch(`${BASE}/sessions`, { method: "POST", body: form });
  return handle(resp);
}

export async function getSession(id: string): Promise<Session> {
  return handle(await fetch(`${BASE}/sessions/${id}`));
}

export async function confirmFrame(id: string, timeSec: number): Promise<{ freezeSec: number; frameUrl: string }> {
  return handle(
    await fetch(`${BASE}/sessions/${id}/frame`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ timeSec }),
    }),
  );
}

export async function submitPose(id: string, pose: PoseKeypoint[], maskPngBase64: string): Promise<void> {
  await handle(
    await fetch(`${BASE}/sessions/${id}/pose`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pose, maskPngBase64 }),
    }),
  );
}

/** Uploads an already client-aligned anatomy image (see cv/alignment.ts) as the session's anatomy frame. */
export async function uploadAnatomyImage(id: string, imagePngBase64: string): Promise<{ imageUrl: string }> {
  return handle(
    await fetch(`${BASE}/sessions/${id}/anatomy/upload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ imagePngBase64 }),
    }),
  );
}

export async function generateAnatomy(
  id: string,
  exerciseName: string | undefined,
  feedback: string | undefined,
): Promise<{ attempt: number; imageUrl: string; provider: string }> {
  return handle(
    await fetch(`${BASE}/sessions/${id}/anatomy/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ exerciseName, feedback }),
    }),
  );
}

export async function checkAnatomyQuality(
  id: string,
  candidatePose: PoseKeypoint[],
): Promise<{ quality: QualityScore; canRegenerate: boolean; attemptsUsed: number; maxAttempts: number }> {
  return handle(
    await fetch(`${BASE}/sessions/${id}/anatomy/quality-check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ candidatePose }),
    }),
  );
}

export async function approveAnatomy(id: string): Promise<void> {
  await handle(await fetch(`${BASE}/sessions/${id}/anatomy/approve`, { method: "POST" }));
}

export async function analyzeMuscles(id: string, exerciseName?: string): Promise<{ muscles: MuscleSuggestion[] }> {
  return handle(
    await fetch(`${BASE}/sessions/${id}/muscles/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ exerciseName }),
    }),
  );
}

export async function saveMuscles(id: string, muscles: MuscleSuggestion[]): Promise<void> {
  await handle(
    await fetch(`${BASE}/sessions/${id}/muscles`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ muscles }),
    }),
  );
}

export async function generateHighlight(id: string): Promise<{ imageUrl: string; labels: LabelPlacement[] }> {
  return handle(await fetch(`${BASE}/sessions/${id}/highlight`, { method: "POST" }));
}

export interface TimelineState {
  freezeDurationSec: number;
  transitionInSec: number;
  transitionOutSec: number;
  trimStartSec: number;
  trimEndSec: number;
}

export async function setTimeline(id: string, patch: Partial<TimelineState>): Promise<TimelineState> {
  return handle(
    await fetch(`${BASE}/sessions/${id}/timeline`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }),
  );
}

export async function exportVideo(id: string): Promise<{ downloadUrl: string; durationSec: number }> {
  return handle(await fetch(`${BASE}/sessions/${id}/export`, { method: "POST" }));
}

export interface AnatomyNudgeDelta {
  offsetXPct?: number;
  offsetYPct?: number;
  scaleDelta?: number;
  rotationDeltaDeg?: number;
}

export interface ChatEditResponse {
  reply: string;
  provider: string;
  anatomyNudge: AnatomyNudgeDelta | null;
  frameChanged: boolean;
  frameUrl?: string;
  timeline: { freezeSec: number } & TimelineState;
}

/** Sends a natural-language edit request to the AI chat; the server applies timing/trim changes directly. */
export async function sendChatEdit(id: string, message: string): Promise<ChatEditResponse> {
  return handle(
    await fetch(`${BASE}/sessions/${id}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
    }),
  );
}
