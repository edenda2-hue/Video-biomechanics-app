import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import OpenAI, { toFile } from "openai";
import sharp from "sharp";
import { OPENAI_API_KEY, OPENAI_IMAGE_MODEL, OPENAI_TEXT_MODEL } from "../../config.js";
import type { MuscleSuggestion } from "../../types.js";
import { buildGeneratePrompt, buildHighlightPrompt, buildMuscleAnalysisPrompt } from "./prompts.js";
import type { AnalyzeMusclesInput, AnatomyProvider, GenerateAnatomyInput, HighlightMusclesInput } from "./types.js";

const client = new OpenAI({ apiKey: OPENAI_API_KEY });

/** OpenAI's images.edit API treats *transparent* pixels as editable; our internal mask is person=white(editable). Invert into alpha. */
async function toOpenAiEditMask(internalMaskPath: string, width: number, height: number): Promise<Buffer> {
  const grey = await sharp(internalMaskPath).resize(width, height).greyscale().raw().toBuffer();
  const rgba = Buffer.alloc(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const o = p * 4;
    rgba[o] = 0;
    rgba[o + 1] = 0;
    rgba[o + 2] = 0;
    rgba[o + 3] = 255 - grey[p]; // person (grey=255) -> alpha 0 (editable)
  }
  return sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

export class RealOpenAiProvider implements AnatomyProvider {
  readonly name = "openai";

  async generateAnatomy(input: GenerateAnatomyInput): Promise<{ imagePath: string }> {
    const { framePath, maskPath, pose, exerciseName, outPath, feedback } = input;
    const { width, height } = await sharp(framePath).metadata();
    if (!width || !height) throw new Error("Could not read frame dimensions");

    const prompt = buildGeneratePrompt(exerciseName, pose, feedback);
    const editMask = await toOpenAiEditMask(maskPath, width, height);

    const result = await client.images.edit({
      model: OPENAI_IMAGE_MODEL,
      image: await toFile(fs.createReadStream(framePath), path.basename(framePath)),
      mask: await toFile(editMask, "mask.png", { type: "image/png" }),
      prompt,
      size: "auto",
      n: 1,
    });

    const b64 = result.data?.[0]?.b64_json;
    if (!b64) throw new Error("OpenAI image edit returned no image data");
    await fsp.writeFile(outPath, Buffer.from(b64, "base64"));
    return { imagePath: outPath };
  }

  async analyzeMuscles(input: AnalyzeMusclesInput): Promise<Omit<MuscleSuggestion, "id" | "source">[]> {
    const { framePath, pose, exerciseName } = input;
    const imageB64 = await fsp.readFile(framePath, { encoding: "base64" });
    const prompt = buildMuscleAnalysisPrompt(exerciseName, pose);

    const completion = await client.chat.completions.create({
      model: OPENAI_TEXT_MODEL,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: `data:image/png;base64,${imageB64}` } },
          ],
        },
      ],
    });

    const content = completion.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(content) as { muscles?: { name: string; role: string; anchor: { x: number; y: number } }[] };
    return (parsed.muscles ?? []).map((m) => ({
      name: m.name,
      role: normalizeRole(m.role),
      anchor: { x: clamp01(m.anchor?.x ?? 0.5), y: clamp01(m.anchor?.y ?? 0.5) },
    }));
  }

  async highlightMuscles(input: HighlightMusclesInput): Promise<{ imagePath: string }> {
    const { anatomyImagePath, maskPath, muscles, outPath } = input;
    const { width, height } = await sharp(anatomyImagePath).metadata();
    if (!width || !height) throw new Error("Could not read image dimensions");

    const prompt = buildHighlightPrompt(muscles);
    const editMask = await toOpenAiEditMask(maskPath, width, height);

    const result = await client.images.edit({
      model: OPENAI_IMAGE_MODEL,
      image: await toFile(fs.createReadStream(anatomyImagePath), path.basename(anatomyImagePath)),
      mask: await toFile(editMask, "mask.png", { type: "image/png" }),
      prompt,
      size: "auto",
      n: 1,
    });

    const b64 = result.data?.[0]?.b64_json;
    if (!b64) throw new Error("OpenAI image edit returned no image data");
    await fsp.writeFile(outPath, Buffer.from(b64, "base64"));
    return { imagePath: outPath };
  }
}

function normalizeRole(role: string): MuscleSuggestion["role"] {
  return role === "agonist" || role === "synergist" || role === "stabilizer" ? role : "synergist";
}

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v));
}
