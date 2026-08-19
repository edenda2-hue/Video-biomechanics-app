import { OPENAI_API_KEY } from "../../config.js";
import { MockAnatomyProvider } from "./mockProvider.js";
import { RealOpenAiProvider } from "./realProvider.js";
import type { AnatomyProvider } from "./types.js";

let cached: AnatomyProvider | null = null;

export function getProvider(): AnatomyProvider {
  if (cached) return cached;
  if (OPENAI_API_KEY) {
    cached = new RealOpenAiProvider();
  } else {
    console.warn(
      "[openai] OPENAI_API_KEY not set — using the offline MockAnatomyProvider. " +
        "Set OPENAI_API_KEY to use real anatomy generation / kinesiological analysis.",
    );
    cached = new MockAnatomyProvider();
  }
  return cached;
}

export type { AnatomyProvider } from "./types.js";
