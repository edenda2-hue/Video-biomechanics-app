// Manual smoke test for the backend pipeline's primary flow: upload video
// -> confirm frame -> submit pose/mask (standing in for the client-side CV
// Engine) -> upload a manually-created (pre-aligned) anatomy image -> set
// timeline -> exercise the AI edit chat (hold duration, anatomy nudge, trim,
// and moving the freeze point, which re-extracts the frame server-side) ->
// export, then verify the exported MP4 with ffprobe.
// Run with: node scripts/e2e-smoke.mjs
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

  console.log("4. submitting synthetic pose + segmentation mask (stand-in for browser CV Engine)...");
  const pose = fakePose();
  const maskPngBase64 = (await fakeMask()).toString("base64");
  await postJson(`/sessions/${sessionId}/pose`, { pose, maskPngBase64 });

  console.log("5. uploading a manually-created anatomy image (stand-in for the client-aligned upload)...");
  const anatomyPngBase64 = (await fakeAnatomyImage()).toString("base64");
  const uploaded = await postJson(`/sessions/${sessionId}/anatomy/upload`, { imagePngBase64: anatomyPngBase64 });
  console.log("   ", uploaded);

  console.log("6. setting preview timeline (freeze=2s, transitions=0.4s each)...");
  await fetch(`${BASE}/sessions/${sessionId}/timeline`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ freezeDurationSec: 2, transitionInSec: 0.4, transitionOutSec: 0.4 }),
  }).then(checkOk);

  console.log("6b. exercising the chat-edit endpoint (mock provider expected without OPENAI_API_KEY)...");
  const chat1 = await postJson(`/sessions/${sessionId}/chat`, { message: "hold it 1 second longer" });
  console.log("    reply:", chat1.reply, "| timeline:", chat1.timeline);
  assert(chat1.provider === "mock", "mock chat provider should be selected without an API key");
  assert(Math.abs(chat1.timeline.freezeDurationSec - 3) < 1e-6, "chat extended freezeDurationSec by 1s (2s -> 3s)");

  const chat2 = await postJson(`/sessions/${sessionId}/chat`, { message: "move the anatomy right 10%" });
  console.log("    reply:", chat2.reply, "| anatomyNudge:", chat2.anatomyNudge);
  assert(chat2.anatomyNudge && Math.abs(chat2.anatomyNudge.offsetXPct - 0.1) < 1e-6, "chat returned a +10% rightward nudge");

  const chat3 = await postJson(`/sessions/${sessionId}/chat`, { message: "trim the end to 2.5 seconds" });
  console.log("    reply:", chat3.reply, "| timeline:", chat3.timeline);
  assert(Math.abs(chat3.timeline.trimEndSec - 2.5) < 1e-6, "chat set trimEndSec to 2.5s");

  const chat4 = await postJson(`/sessions/${sessionId}/chat`, { message: "move the freeze point to 1.2 seconds" });
  console.log("    reply:", chat4.reply, "| frameChanged:", chat4.frameChanged, "| timeline:", chat4.timeline);
  assert(chat4.frameChanged === true, "moving the freeze point re-extracts the frame server-side");
  assert(Math.abs(chat4.timeline.freezeSec - 1.2) < 1e-6, "chat moved freezeSec to 1.2s");

  console.log("6c. re-submitting pose/mask for the frame chat moved us to (stand-in for the browser CV Engine re-running)...");
  await postJson(`/sessions/${sessionId}/pose`, { pose, maskPngBase64 });

  console.log("7. starting async export job (wipe transition, trimmed to [0, 2.5]s)...");
  const started = await postJson(`/sessions/${sessionId}/export`, {});
  console.log("   ", started);
  assert(started.jobId === sessionId, "export returns a jobId immediately (doesn't block on rendering)");

  console.log("7b. polling export status until done...");
  let job;
  const deadline = Date.now() + 60_000;
  const seenPhases = new Set();
  while (Date.now() < deadline) {
    job = await checkOk(await fetch(`${BASE}/sessions/${sessionId}/export/status`));
    seenPhases.add(job.phase);
    if (job.phase === "done" || job.phase === "error") break;
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log("    final job status:", job);
  assert(job.phase === "done", `export job completed successfully (got: ${job.phase} - ${job.error ?? ""})`);
  assert(seenPhases.has("compositing"), "observed the compositing phase while polling");

  const outPath = path.join(TMP, "export.mp4");
  const resp = await fetch(`${BASE}/sessions/${sessionId}/export/file`);
  await checkOk(resp);
  await fs.writeFile(outPath, Buffer.from(await resp.arrayBuffer()));

  console.log("8. verifying exported file with ffprobe...");
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
  // trim [0, 2.5]s (via chat) + freezeDurationSec=3s (2s + 1s via chat)
  const expectedDuration = 2.5 + 3;
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

async function fakeAnatomyImage() {
  // Stands in for a manually-created, already-aligned anatomy image: same
  // dimensions as the frame, a distinct color inside the person ellipse so
  // the wipe/compositing effect is visually verifiable.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
    <rect width="100%" height="100%" fill="black" />
    <ellipse cx="${WIDTH * 0.5}" cy="${HEIGHT * 0.5}" rx="${WIDTH * 0.16}" ry="${HEIGHT * 0.42}" fill="#8b0000" />
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
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
