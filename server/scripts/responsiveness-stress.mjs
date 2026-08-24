// Verifies the server stays responsive to concurrent requests (e.g. the
// export-status poll) while a large-resolution keyframe export is
// compositing, which is exactly the scenario that produced a 502 in
// production. Fires a health-check request every 100ms throughout a real
// 1920x1080 keyframe export and reports the worst observed latency.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";

const run = promisify(execFile);
const BASE = "http://localhost:8787/api";
const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;
const DURATION = 4;
const TMP = "/tmp/vba-stress";

async function main() {
  await fs.mkdir(TMP, { recursive: true });
  const videoPath = path.join(TMP, "source.mp4");
  console.log(`generating a ${WIDTH}x${HEIGHT} synthetic test video...`);
  await run("ffmpeg", [
    "-y", "-f", "lavfi", "-i", `testsrc2=size=${WIDTH}x${HEIGHT}:rate=${FPS}:duration=${DURATION}`,
    "-pix_fmt", "yuv420p", videoPath,
  ]);

  const form = new FormData();
  form.append("video", new Blob([await fs.readFile(videoPath)], { type: "video/mp4" }), "source.mp4");
  const created = await postForm("/sessions", form);
  const sessionId = created.id;
  console.log("session:", sessionId, created.metadata);

  const kf = await postJson(`/sessions/${sessionId}/keyframes`, { timeSec: 1.0 });
  const pose = fakePose();
  const maskPngBase64 = (await fakeMask()).toString("base64");
  await postJson(`/sessions/${sessionId}/keyframes/${kf.id}/pose`, { pose, maskPngBase64 });
  const anatomy = (await fakeAnatomyImage()).toString("base64");
  await postJson(`/sessions/${sessionId}/keyframes/${kf.id}/anatomy`, { imagePngBase64: anatomy });
  await fetch(`${BASE}/sessions/${sessionId}/keyframes/${kf.id}`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ holdDurationSec: 3, transitionInSec: 0.5, transitionOutSec: 0.5 }),
  }).then(checkOk);

  console.log("starting export and hammering /health concurrently every 100ms...");
  const started = await postJson(`/sessions/${sessionId}/keyframes/export`, {});
  console.log("job:", started);

  const latencies = [];
  let failures = 0;
  let done = false;
  const hammer = (async () => {
    while (!done) {
      const t0 = Date.now();
      try {
        await fetch(`${BASE}/health`);
        latencies.push(Date.now() - t0);
      } catch {
        failures++;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  })();

  const deadline = Date.now() + 60_000;
  let job;
  while (Date.now() < deadline) {
    job = await getJson(`/sessions/${sessionId}/keyframes/export/status`);
    if (job.phase === "done" || job.phase === "error") break;
    await new Promise((r) => setTimeout(r, 300));
  }
  done = true;
  await hammer;

  console.log("final job status:", job);
  latencies.sort((a, b) => a - b);
  const max = latencies[latencies.length - 1] ?? -1;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? -1;
  console.log(`health-check requests during compositing: ${latencies.length} succeeded, ${failures} failed`);
  console.log(`latency: max=${max}ms, p95=${p95}ms`);

  if (job.phase !== "done") throw new Error("export did not complete: " + JSON.stringify(job));
  if (failures > 0) throw new Error(`${failures} concurrent health-check requests failed during compositing`);
  if (max > 2000) throw new Error(`worst-case latency ${max}ms is too high — server was still blocking significantly`);

  console.log("\nSTRESS TEST PASSED: server stayed responsive throughout a 1920x1080 export.");
}

function fakePose() {
  const parts = {
    head: [0.5, 0.12], neck: [0.5, 0.2], left_shoulder: [0.42, 0.24], right_shoulder: [0.58, 0.24],
    left_elbow: [0.35, 0.38], right_elbow: [0.65, 0.38], left_wrist: [0.3, 0.5], right_wrist: [0.7, 0.5],
    left_hand: [0.29, 0.52], right_hand: [0.71, 0.52], spine: [0.5, 0.35], pelvis: [0.5, 0.5],
    left_hip: [0.45, 0.5], right_hip: [0.55, 0.5], left_knee: [0.44, 0.68], right_knee: [0.56, 0.68],
    left_ankle: [0.43, 0.86], right_ankle: [0.57, 0.86], left_foot: [0.42, 0.9], right_foot: [0.58, 0.9],
  };
  return Object.entries(parts).map(([part, [x, y]]) => ({ part, x, y, confidence: 0.95 }));
}

async function fakeMask() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
    <rect width="100%" height="100%" fill="black" />
    <ellipse cx="${WIDTH * 0.5}" cy="${HEIGHT * 0.5}" rx="${WIDTH * 0.16}" ry="${HEIGHT * 0.42}" fill="white" />
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function fakeAnatomyImage() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
    <rect width="100%" height="100%" fill="black" />
    <ellipse cx="${WIDTH * 0.5}" cy="${HEIGHT * 0.5}" rx="${WIDTH * 0.16}" ry="${HEIGHT * 0.42}" fill="#8b0000" />
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function postJson(p, body) {
  return checkOk(await fetch(`${BASE}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
}
async function getJson(p) {
  return checkOk(await fetch(`${BASE}${p}`));
}
async function postForm(p, form) {
  return checkOk(await fetch(`${BASE}${p}`, { method: "POST", body: form }));
}
async function checkOk(resp) {
  if (!resp.ok) throw new Error(`${resp.status} ${resp.url}: ${await resp.text()}`);
  const ct = resp.headers.get("content-type") ?? "";
  return ct.includes("application/json") ? resp.json() : resp;
}

main().catch((err) => {
  console.error("STRESS TEST FAILED:", err);
  process.exit(1);
});
