export type ExportPhase = "compositing" | "encoding-segment" | "assembling" | "done" | "error";

export interface ExportJob {
  phase: ExportPhase;
  /** Overall progress across the whole pipeline, 0-100. */
  percent: number;
  /** Short human-readable description of the current step. */
  message: string;
  error?: string;
  downloadUrl?: string;
}

const jobs = new Map<string, ExportJob>();

export function setJob(sessionId: string, job: ExportJob) {
  jobs.set(sessionId, job);
}

export function getJob(sessionId: string): ExportJob | undefined {
  return jobs.get(sessionId);
}
