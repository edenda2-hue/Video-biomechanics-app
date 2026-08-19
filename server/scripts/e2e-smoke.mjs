// Manual smoke test for the backend pipeline, using a synthetic video and a
// fabricated pose/mask (standing in for the client-side CV Engine) so the
// whole flow (frame extraction -> mock anatomy -> quality gate -> muscle
// analysis -> highlight -> export) can be exercised without a browser or an
// OpenAI API key. Run with: node scripts/e2e-smoke.mjs
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";

const run = promisify(execFile);
const BASE = process.env.BASE_URL ?? "http://localhost:8787/api";
const WIDTH = 640;
const HEIGHT = 360;
const FPS = 30;
const DURATION = 3;

const TMP = "/tmp/vba-smoke";

async function main() {
  await fs.mkdir(TMP, { recursive: true });
  const videoPath = path.join(TMP, "synthetic.mp4");
  console.log("1. generating synthetic test video...");
  await run("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc=size=${WIDTH}x${HEIGHT}:rate=${FPS}:duration=${DURATION}`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:duration=${DURATION}`,
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    videoPath,
  ]);

  console.log("2. uploading video / creating session...");
  const form = new FormData();
  form.append("video", new Blob([await fs.readFile(videoPath)], { type: "video/mp4" }), "synthetic.mp4");
  const created = await postForm("/sessions", form);
  const sessionId = created.id;
  console.log("   session:", sessionId, created.metadata);
  assert(created.metadata.width === WIDTH && created.metadata.height === HEIGHT, "resolution preserved on upload");
  assert(Math.abs(created.metadata.fps - FPS) < 0.5, "fps preserved on upload");

  console.log("3. confirming freeze frame at t=1.0s...");
  const freezeSec = 1.0;
  await postJson(`/sessions/${sessionId}/frame`, { timeSec: freezeSec });

  console.log("4. submitting synthetic pose + segmentation mask...");
  const pose = fakePose();
  const maskPngBase64 = (await fakeMask()).toString("base64");
  await postJson(`/sessions/${sessionId}/pose`, { pose, maskPngBase64 });

  console.log("5. generating anatomy candidate (mock provider expected without OPENAI_API_KEY)...");
  const gen = await postJson(`/sessions/${sessionId}/anatomy/generate`, { exerciseName: "front lever" });
  console.log("   provider:", gen.provider, "attempt:", gen.attempt);
  assert(gen.provider === "mock", "mock provider should be selected without an API key");

  console.log("6. running quality gate (candidate pose == original pose -> should pass)...");
  const qc = await postJson(`/sessions/${sessionId}/anatomy/quality-check`, { candidatePose: pose });
  console.log("   quality:", qc.quality);
  assert(qc.quality.passed, "quality gate should pass for a geometry-preserving mock candidate");

  console.log("7. approving anatomy...");
  await postJson(`/sessions/${sessionId}/anatomy/approve`, {});

  console.log("8. analyzing muscles...");
  const analysis = await postJson(`/sessions/${sessionId}/muscles/analyze`, { exerciseName: "front lever" });
  console.log(
    "   muscles:",
    analysis.muscles.map((m) => m.name),
  );
  assert(analysis.muscles.length > 0, "at least one muscle suggested");

  console.log("9. approving muscle selection as-is...");
  await fetch(`${BASE}/sessions/${sessionId}/muscles`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ muscles: analysis.muscles }),
  }).then(checkOk);

  console.log("10. generating muscle highlight + labels...");
  const highlight = await postJson(`/sessions/${sessionId}/highlight`, {});
  console.log("    labels:", highlight.labels.map((l) => `${l.name}@(${l.labelPos.x.toFixed(2)},${l.labelPos.y.toFixed(2)})`));
  assert(highlight.labels.length === analysis.muscles.length, "one label per selected muscle");
  assertNoOverlap(highlight.labels);

  console.log("11. setting preview timeline (freeze=2s, transitions=0.4s each)...");
  await fetch(`${BASE}/sessions/${sessionId}/timeline`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ freezeDurationSec: 2, transitionInSec: 0.4, transitionOutSec: 0.4 }),
  }).then(checkOk);

  console.log("12. exporting final video...");
  const exported = await postJson(`/sessions/${sessionId}/export`, {});
  console.log("   ", exported);

  const outPath = path.join(TMP, "export.mp4");
  const resp = await fetch(`${BASE}/sessions/${sessionId}/export/file`);
  await checkOk(resp);
  await fs.writeFile(outPath, Buffer.from(await resp.arrayBuffer()));

  console.log("13. verifying exported file with ffprobe...");
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    outPath,
  ]);
  const probe = JSON.parse(stdout);
  const v = probe.streams.find((s) => s.codec_type === "video");
  const a = probe.streams.find((s) => s.codec_type === "audio");
  console.log("    video:", v.width, "x", v.height, v.r_frame_rate, "duration:", probe.format.duration);
  console.log("    has audio track:", Boolean(a));

  assert(Number(v.width) === WIDTH && Number(v.height) === HEIGHT, "export resolution matches original");
  const expectedDuration = DURATION + 2; // original + freeze duration
  assert(Math.abs(Number(probe.format.duration) - expectedDuration) < 0.5, `export duration ~= ${expectedDuration}s`);
  assert(Boolean(a), "export retains an audio track");

  console.log("\nALL CHECKS PASSED. Output:", outPath);
}

function fakePose() {
  // A rough standing stick figure roughly centered in frame, normalized coords.
  const parts = {
    head: [0.5, 0.12],
    neck: [0.5, 0.2],
    left_shoulder: [0.42, 0.24],
    right_shoulder: [0.58, 0.24],
    left_elbow: [0.35, 0.38],
    right_elbow: [0.65, 0.38],
    left_wrist: [0.3, 0.5],
    right_wrist: [0.7, 0.5],
    left_hand: [0.29, 0.52],
    right_hand: [0.71, 0.52],
    spine: [0.5, 0.35],
    pelvis: [0.5, 0.5],
    left_hip: [0.45, 0.5],
    right_hip: [0.55, 0.5],
    left_knee: [0.44, 0.68],
    right_knee: [0.56, 0.68],
    left_ankle: [0.43, 0.86],
    right_ankle: [0.57, 0.86],
    left_foot: [0.42, 0.9],
    right_foot: [0.58, 0.9],
  };
  return Object.entries(parts).map(([part, [x, y]]) => ({ part, x, y, confidence: 0.95 }));
}

async function fakeMask() {
  // A simple ellipse covering the "person" silhouette used above.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
    <rect width="100%" height="100%" fill="black" />
    <ellipse cx="${WIDTH * 0.5}" cy="${HEIGHT * 0.5}" rx="${WIDTH * 0.16}" ry="${HEIGHT * 0.42}" fill="white" />
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function assertNoOverlap(labels) {
  const bySide = { left: [], right: [] };
  for (const l of labels) bySide[l.labelPos.x < 0.5 ? "left" : "right"].push(l.labelPos.y);
  for (const side of Object.values(bySide)) {
    side.sort((a, b) => a - b);
    for (let i = 1; i < side.length; i++) {
      assert(side[i] - side[i - 1] > 0.01, "labels on the same side must not collide vertically");
    }
  }
}

async function postJson(p, body) {
  const resp = await fetch(`${BASE}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return checkOk(resp);
}

async function postForm(p, form) {
  const resp = await fetch(`${BASE}${p}`, { method: "POST", body: form });
  return checkOk(resp);
}

async function checkOk(resp) {
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`${resp.status} ${resp.url}: ${text}`);
  }
  const ct = resp.headers.get("content-type") ?? "";
  return ct.includes("application/json") ? resp.json() : resp;
}

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
}

main().catch((err) => {
  console.error("SMOKE TEST FAILED:", err);
  process.exit(1);
});
