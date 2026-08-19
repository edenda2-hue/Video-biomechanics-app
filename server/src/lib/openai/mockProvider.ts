import fsp from "node:fs/promises";
import sharp from "sharp";
import type { MuscleSuggestion, PoseKeypoint } from "../../types.js";
import type { AnalyzeMusclesInput, AnatomyProvider, GenerateAnatomyInput, HighlightMusclesInput } from "./types.js";

/**
 * Deterministic, offline stand-in for the real OpenAI calls (used when
 * OPENAI_API_KEY is unset, e.g. local dev or this repo's own test run).
 * It never touches the network. It applies a duotone "anatomy-style" filter
 * strictly *inside* the person mask via sharp so the rest of the pipeline
 * (compositing, quality gate, export) can be exercised end-to-end.
 */
export class MockAnatomyProvider implements AnatomyProvider {
  readonly name = "mock";

  async generateAnatomy(input: GenerateAnatomyInput): Promise<{ imagePath: string }> {
    const { framePath, maskPath, outPath } = input;
    const { width, height } = await sharp(framePath).metadata();
    if (!width || !height) throw new Error("Could not read frame dimensions");

    const original = await sharp(framePath).ensureAlpha().raw().toBuffer();
    const mask = await sharp(maskPath).resize(width, height).greyscale().raw().toBuffer();

    // Stylize toward a muted red/tan "musculoskeletal" duotone inside the mask only.
    const stylized = Buffer.from(original);
    for (let p = 0; p < width * height; p++) {
      const m = mask[p] / 255;
      if (m < 0.05) continue;
      const o = p * 4;
      const grey = 0.3 * original[o] + 0.59 * original[o + 1] + 0.11 * original[o + 2];
      const r = grey * 0.9 + 60;
      const g = grey * 0.55;
      const b = grey * 0.5;
      stylized[o] = Math.round(original[o] * (1 - m) + r * m);
      stylized[o + 1] = Math.round(original[o + 1] * (1 - m) + g * m);
      stylized[o + 2] = Math.round(original[o + 2] * (1 - m) + b * m);
    }

    await sharp(stylized, { raw: { width, height, channels: 4 } }).png().toFile(outPath);
    return { imagePath: outPath };
  }

  async analyzeMuscles(input: AnalyzeMusclesInput): Promise<Omit<MuscleSuggestion, "id" | "source">[]> {
    return sampleMuscles(input.exerciseName, input.pose);
  }

  async highlightMuscles(input: HighlightMusclesInput): Promise<{ imagePath: string }> {
    const { anatomyImagePath, muscles, outPath } = input;
    const { width, height } = await sharp(anatomyImagePath).metadata();
    if (!width || !height) throw new Error("Could not read image dimensions");

    const base = await sharp(anatomyImagePath).ensureAlpha().raw().toBuffer();
    const out = Buffer.from(base);
    const radius = Math.max(width, height) * 0.08;

    for (const m of muscles) {
      const cx = m.anchor.x * width;
      const cy = m.anchor.y * height;
      const x0 = Math.max(0, Math.floor(cx - radius));
      const x1 = Math.min(width, Math.ceil(cx + radius));
      const y0 = Math.max(0, Math.floor(cy - radius));
      const y1 = Math.min(height, Math.ceil(cy + radius));
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const d = Math.hypot(x - cx, y - cy) / radius;
          if (d > 1) continue;
          const strength = (1 - d) * 0.6;
          const p = (y * width + x) * 4;
          out[p] = Math.round(out[p] * (1 - strength) + 90 * strength);
          out[p + 1] = Math.round(out[p + 1] * (1 - strength));
          out[p + 2] = Math.round(out[p + 2] * (1 - strength));
        }
      }
    }

    await sharp(out, { raw: { width, height, channels: 4 } }).png().toFile(outPath);
    return { imagePath: outPath };
  }
}

const FRONT_LEVER_MUSCLES: { name: string; role: MuscleSuggestion["role"]; parts: [string, string] }[] = [
  { name: "Latissimus Dorsi", role: "agonist", parts: ["left_shoulder", "pelvis"] },
  { name: "Triceps Brachii", role: "synergist", parts: ["left_elbow", "left_shoulder"] },
  { name: "Rectus Abdominis", role: "stabilizer", parts: ["spine", "pelvis"] },
  { name: "Gluteus Maximus", role: "stabilizer", parts: ["pelvis", "left_hip"] },
];

function sampleMuscles(exerciseName: string | undefined, pose: PoseKeypoint[]): Omit<MuscleSuggestion, "id" | "source">[] {
  const byPart = new Map(pose.map((k) => [k.part, k]));
  const template = FRONT_LEVER_MUSCLES;
  return template.map((t) => {
    const a = byPart.get(t.parts[0] as any);
    const b = byPart.get(t.parts[1] as any);
    const anchor = a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : { x: 0.5, y: 0.5 };
    return { name: t.name, role: t.role, anchor };
  });
}
