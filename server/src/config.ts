import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PORT = Number(process.env.PORT ?? 8787);
export const DATA_DIR = path.resolve(__dirname, "../data");
export const SESSIONS_DIR = path.join(DATA_DIR, "sessions");

export const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
// gpt-image-1 is deprecating 2026-10-23; gpt-image-2 is the current
// recommended images.edit model (same mask-based edit API shape).
export const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-2";
export const OPENAI_TEXT_MODEL = process.env.OPENAI_TEXT_MODEL ?? "gpt-4.1";

// Quality gate thresholds (section 5 of the spec: "Quality Score").
export const QUALITY_THRESHOLDS = {
  poseAlignment: 0.85,
  backgroundConsistency: 0.9,
  overall: 0.88,
};

export const MAX_REGENERATE_ATTEMPTS = 3;
