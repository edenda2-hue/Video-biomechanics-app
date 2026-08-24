import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { SESSIONS_DIR } from "../config.js";
import type { Session } from "../types.js";

const sessions = new Map<string, Session>();

export async function createSession(originalVideoPath: string): Promise<Session> {
  const id = nanoid(12);
  const dir = sessionDir(id);
  await fs.mkdir(dir, { recursive: true });
  const session: Session = {
    id,
    createdAt: Date.now(),
    originalVideoPath,
    freezeDurationSec: 5,
    transitionInSec: 0.6,
    transitionOutSec: 0.6,
    trimStartSec: 0,
    anatomyApproved: false,
    muscles: [],
    labels: [],
    attempts: 0,
    keyframes: [],
  };
  sessions.set(id, session);
  return session;
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function requireSession(id: string): Session {
  const s = sessions.get(id);
  if (!s) throw new HttpError(404, `Unknown session: ${id}`);
  return s;
}

export function updateSession(id: string, patch: Partial<Session>): Session {
  const s = requireSession(id);
  Object.assign(s, patch);
  return s;
}

export function sessionDir(id: string): string {
  return path.join(SESSIONS_DIR, id);
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
