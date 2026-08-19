import type { PoseKeypoint } from "../../types.js";

/**
 * The fixed anatomy instruction from the spec ("הנחיית האנטומיה", section 4),
 * translated faithfully. This text must never be altered per-request beyond
 * appending the exercise name / pose landmarks.
 */
export const FIXED_ANATOMY_INSTRUCTION = `The original frame is the single source of truth.
Do not regenerate the scene.
Do not change the background, camera, equipment, apparatus, lighting, perspective, or composition.
Replace only the human body with a realistic, professional anatomical figure of the musculoskeletal system.
The anatomical figure must be in the exact same pose and proportions as the original person.
The head, shoulders, elbows, hands, spine, pelvis, knees, ankles, and feet must be aligned as closely as possible to their positions in the original frame.
The result must look as if the filmed person themself turned into an anatomical figure.`;

export function buildGeneratePrompt(exerciseName: string | undefined, pose: PoseKeypoint[], feedback?: string): string {
  const landmarks = pose
    .filter((k) => k.confidence >= 0.3)
    .map((k) => `${k.part}: (${k.x.toFixed(3)}, ${k.y.toFixed(3)})`)
    .join("; ");

  return [
    FIXED_ANATOMY_INSTRUCTION,
    exerciseName ? `Exercise being performed: ${exerciseName}.` : null,
    `Reference joint landmarks (normalized image coordinates, origin top-left): ${landmarks}.`,
    feedback ? `Previous attempt was rejected by automated quality control: ${feedback} Correct this in the new attempt.` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildMuscleAnalysisPrompt(exerciseName: string | undefined, pose: PoseKeypoint[]): string {
  const landmarks = pose
    .filter((k) => k.confidence >= 0.3)
    .map((k) => `${k.part}: (${k.x.toFixed(3)}, ${k.y.toFixed(3)})`)
    .join("; ");

  return `You are a kinesiology/biomechanics expert analyzing a single freeze-frame from a sports movement.
Exercise: ${exerciseName ?? "unknown, infer from the pose"}.
Joint landmarks (normalized image coordinates, origin top-left): ${landmarks}.

Identify the primary muscles involved in holding/producing this position: agonists, synergists, and stabilizers.
For each muscle give an anatomically appropriate anchor point (normalized 0-1 image coordinates) located ON the muscle belly itself, positioned consistently with the given joint landmarks.

Respond with strict JSON: {"muscles": [{"name": string, "role": "agonist"|"synergist"|"stabilizer", "anchor": {"x": number, "y": number}}]}. Return 4-8 muscles, most important first. No prose, JSON only.`;
}

export function buildHighlightPrompt(muscles: { name: string; anchor: { x: number; y: number } }[]): string {
  const list = muscles.map((m) => `- ${m.name} (near normalized point x=${m.anchor.x.toFixed(2)}, y=${m.anchor.y.toFixed(2)})`).join("\n");

  return `This is an anatomical musculoskeletal figure. Highlight ONLY the following specific muscles by deepening their natural tissue pigmentation to a deep, dark red:
${list}

Rules:
- Do not use glow, neon, flash, pulse, flat color overlays, blotches, or artificial geometric masks.
- The muscle must remain realistic anatomical tissue: preserve muscle fiber direction, fascicle striations, texture, shading, depth, and anatomical contours/boundaries.
- Only the listed muscles change color; every other muscle, bone, and the rest of the image stays exactly as-is.
- Do not change the pose, proportions, camera, background, or equipment.`;
}
