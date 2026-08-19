import type { LabelPlacement, MuscleSuggestion, PoseKeypoint } from "../types.js";

const MARGIN_X = 0.05;
const MIN_ROW_GAP = 0.055;
const TOP = 0.06;
const BOTTOM = 0.94;

/**
 * Deterministic "Smart Label Placement" (spec section 9): labels are pushed
 * out to free margin columns left/right of the body, stacked so they never
 * overlap each other, the body's bounding box, or the leader lines. This is
 * an Application Backend responsibility, not an AI call, so placement is
 * always reliable.
 */
export function layoutLabels(muscles: MuscleSuggestion[], pose: PoseKeypoint[]): LabelPlacement[] {
  const bodyBox = boundingBox(pose);
  const centerX = (bodyBox.minX + bodyBox.maxX) / 2;

  const left = muscles.filter((m) => m.anchor.x < centerX).sort((a, b) => a.anchor.y - b.anchor.y);
  const right = muscles.filter((m) => m.anchor.x >= centerX).sort((a, b) => a.anchor.y - b.anchor.y);

  return [...placeColumn(left, "left", bodyBox), ...placeColumn(right, "right", bodyBox)];
}

function placeColumn(
  muscles: MuscleSuggestion[],
  side: "left" | "right",
  bodyBox: { minX: number; maxX: number; minY: number; maxY: number },
): LabelPlacement[] {
  const columnX = side === "left" ? MARGIN_X : 1 - MARGIN_X;
  const edgeX = side === "left" ? bodyBox.minX - 0.02 : bodyBox.maxX + 0.02;

  let lastY = TOP;
  const placements: LabelPlacement[] = [];
  for (const m of muscles) {
    const desiredY = clamp(m.anchor.y, TOP, BOTTOM);
    const rowY = Math.max(desiredY, lastY);
    lastY = rowY + MIN_ROW_GAP;

    placements.push({
      muscleId: m.id,
      name: m.name,
      anchor: m.anchor,
      labelPos: { x: columnX, y: Math.min(rowY, BOTTOM) },
      leaderPath: [
        m.anchor,
        { x: edgeX, y: m.anchor.y },
        { x: columnX, y: Math.min(rowY, BOTTOM) },
      ],
    });
  }

  // If the column overflowed, compress rows evenly rather than letting labels run off-canvas.
  if (lastY > BOTTOM && placements.length > 1) {
    const step = (BOTTOM - TOP) / (placements.length - 1 || 1);
    placements.forEach((p, i) => {
      const y = TOP + step * i;
      p.labelPos.y = y;
      p.leaderPath[p.leaderPath.length - 1].y = y;
    });
  }

  return placements;
}

function boundingBox(pose: PoseKeypoint[]) {
  const confident = pose.filter((k) => k.confidence >= 0.3);
  const xs = confident.map((k) => k.x);
  const ys = confident.map((k) => k.y);
  return {
    minX: xs.length ? Math.min(...xs) : 0.35,
    maxX: xs.length ? Math.max(...xs) : 0.65,
    minY: ys.length ? Math.min(...ys) : 0.05,
    maxY: ys.length ? Math.max(...ys) : 0.95,
  };
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}
