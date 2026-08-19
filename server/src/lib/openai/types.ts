import type { MuscleSuggestion, PoseKeypoint } from "../../types.js";

export interface GenerateAnatomyInput {
  framePath: string;
  maskPath: string;
  pose: PoseKeypoint[];
  exerciseName?: string;
  outPath: string;
  /** Present on regenerate attempts so the provider can react to why the previous try failed QC. */
  feedback?: string;
}

export interface AnalyzeMusclesInput {
  framePath: string;
  pose: PoseKeypoint[];
  exerciseName?: string;
}

export interface HighlightMusclesInput {
  anatomyImagePath: string;
  maskPath: string;
  muscles: MuscleSuggestion[];
  outPath: string;
}

export interface AnatomyProvider {
  readonly name: string;
  generateAnatomy(input: GenerateAnatomyInput): Promise<{ imagePath: string }>;
  analyzeMuscles(input: AnalyzeMusclesInput): Promise<Omit<MuscleSuggestion, "id" | "source">[]>;
  highlightMuscles(input: HighlightMusclesInput): Promise<{ imagePath: string }>;
}
