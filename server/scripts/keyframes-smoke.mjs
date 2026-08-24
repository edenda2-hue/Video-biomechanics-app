// End-to-end smoke test for "Anatomy Keyframes" mode: multiple freeze
// points spliced into one video, each with its own hold duration, and the
// head excluded from the anatomy swap (the real head/face should always
// show through). Drives the real HTTP API against a synthetic test video.
// Run with the server up: node scripts/keyframes-smoke.mjs
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";

const run = promisify(execFile);
const BASE = process.env.BASE_URL ?? "http://localhost:8787/api";
const WIDTH = 480;
const HEIGHT = 360;
const FPS = 24;
const DURATION = 6;

const TMP = "/tmp/vba-keyframes-smoke";

async function main() {
  await fs.mkdir(TMP, { recursive: true });
  const videoPath = path.join(TMP, "source.mp4");
  console.log("1. generating synthetic test video...");
  await run("ffmpeg", [
    "-y", "-f", "lavfi", "-i", `testsrc2=size=${WIDTH}x${HEIGHT}:rate=${FPS}:duration=${DURATION}`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${DURATION}`,
    "-pix_fmt", "yuv420p", "-c:a", "aac", videoPath,
  ]);

  console.log("2. creating session...");
  const form = new FormData();
  form.append("video", new Blob([await fs.readFile(videoPath)], { type: "video/mp4" }), "source.mp4");
  const created = await postForm("/sessions", form);
  const sessionId = created.id;
  console.log("   session:", sessionId, created.metadata);

  console.log("3. adding two keyframes at t=1.5s and t=4s...");
  const kf1 = await postJson(`/sessions/${sessionId}/keyframes`, { timeSec: 1.5 });
  const kf2 = await postJson(`/sessions/${sessionId}/keyframes`, { timeSec: 4.0 });
  console.log("   kf1:", kf1.id, "kf2:", kf2.id);

  const listed = await getJson(`/sessions/${sessionId}/keyframes`);
  assert(listed.keyframes.length === 2, "session lists both keyframes");

  console.log("4. downloading kf1's extracted frame (the 'save/copy the specific frame' requirement)...");
  const kf1FrameResp = await fetch(`${new URL(BASE).origin}${kf1.frameUrl}`);
  await checkOk(kf1FrameResp);
  const kf1FrameBuf = Buffer.from(await kf1FrameResp.arrayBuffer());
  assert(kf1FrameBuf.length > 0, "keyframe frame is downloadable and non-empty");

  console.log("5. submitting pose + mask for each keyframe (stand-in for the browser CV Engine)...");
  const pose = fakePose();
  const maskPngBase64 = (await fakeMask()).toString("base64");
  await postJson(`/sessions/${sessionId}/keyframes/${kf1.id}/pose`, { pose, maskPngBase64 });
  await postJson(`/sessions/${sessionId}/keyframes/${kf2.id}/pose`, { pose, maskPngBase64 });

  console.log("6. uploading a distinct anatomy image for each keyframe...");
  const anatomy1 = (await fakeAnatomyImage("#8b0000")).toString("base64"); // dark red
  const anatomy2 = (await fakeAnatomyImage("#006400")).toString("base64"); // dark green
  await postJson(`/sessions/${sessionId}/keyframes/${kf1.id}/anatomy`, { imagePngBase64: anatomy1 });
  await postJson(`/sessions/${sessionId}/keyframes/${kf2.id}/anatomy`, { imagePngBase64: anatomy2 });

  console.log("7. tuning kf1's hold duration to 2s via PUT (the 'editable hold duration' requirement)...");
  const updated = await fetch(`${BASE}/sessions/${sessionId}/keyframes/${kf1.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ holdDurationSec: 2, transitionInSec: 0.3, transitionOutSec: 0.3 }),
  }).then(checkOk);
  assert(Math.abs(updated.holdDurationSec - 2) < 1e-6, "kf1's hold duration was updated");

  console.log("8. starting the multi-keyframe export job...");
  const started = await postJson(`/sessions/${sessionId}/keyframes/export`, {});
  console.log("   ", started);

  console.log("8b. polling export status until done...");
  let job;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    job = await getJson(`/sessions/${sessionId}/keyframes/export/status`);
    if (job.phase === "done" || job.phase === "error") break;
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log("   final job status:", job);
  assert(job.phase === "done", `export completed successfully (got: ${job.phase} - ${job.error ?? ""})`);

  const outPath = path.join(TMP, "keyframes_export.mp4");
  const resp = await fetch(`${BASE}/sessions/${sessionId}/keyframes/export/file`);
  await checkOk(resp);
  await fs.writeFile(outPath, Buffer.from(await resp.arrayBuffer()));

  console.log("9. verifying with ffprobe...");
  const { stdout } = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", outPath]);
  const probe = JSON.parse(stdout);
  const v = probe.streams.find((s) => s.codec_type === "video");
  console.log("    video:", v.width, "x", v.height, v.r_frame_rate, "duration:", probe.format.duration);
  assert(Number(v.width) === WIDTH && Number(v.height) === HEIGHT, "export resolution matches the source");
  // original duration + kf1's hold (2s, updated) + kf2's hold (default 3s)
  const expectedDuration = DURATION + 2 + 3;
  assert(Math.abs(Number(probe.format.duration) - expectedDuration) < 0.5, `export duration ~= ${expectedDuration}s (2 keyframe holds spliced in)`);

  console.log("10. verifying the head-exclusion guarantee: the head region stays the original at a keyframe hold...");
  // fakePose() puts "head" at (0.5, 0.12) normalized -> pixel (240, 43).
  const holdT = kf1.timeSec + 1.0; // well inside kf1's 2s hold, past the 0.3s transition-in
  const srcHeadPath = path.join(TMP, "src-head.png");
  const outHeadPath = path.join(TMP, "out-head.png");
  await run("ffmpeg", ["-y", "-i", videoPath, "-ss", String(kf1.timeSec), "-frames:v", "1", srcHeadPath]);
  await run("ffmpeg", ["-y", "-i", outPath, "-ss", String(holdT), "-frames:v", "1", outHeadPath]);
  const headRegion = { left: 220, top: 20, width: 40, height: 40 }; // around (240,43)
  const srcHeadBuf = await sharp(srcHeadPath).extract(headRegion).raw().toBuffer();
  const outHeadBuf = await sharp(outHeadPath).extract(headRegion).raw().toBuffer();
  const headDiff = meanAbsDiff(srcHeadBuf, outHeadBuf);
  console.log("    mean abs diff in head region:", headDiff.toFixed(2));
  assert(headDiff < 15, "the head region during a keyframe hold still shows the original person, not the anatomy image");

  console.log("11. verifying the body actually swapped to anatomy during the same hold...");
  const bodyRegion = { left: WIDTH / 2 - 20, top: HEIGHT / 2 - 20, width: 40, height: 40 }; // center of the person ellipse in fakeMask()
  const srcBodyBuf = await sharp(srcHeadPath).extract(bodyRegion).raw().toBuffer();
  const outBodyBuf = await sharp(outHeadPath).extract(bodyRegion).raw().toBuffer();
  const bodyDiff = meanAbsDiff(srcBodyBuf, outBodyBuf);
  console.log("    mean abs diff in body region:", bodyDiff.toFixed(2));
  assert(bodyDiff > 20, "the body region during a keyframe hold visibly shows the anatomy image, not the original person");

  console.log("12. verifying footage well outside any keyframe's hold is untouched...");
  const untouchedT = 5.5; // after kf2 (4.0 + 3s hold pushes real playback later, but source-frame comparison below only needs a point clearly between/outside)
  const srcUntouchedPath = path.join(TMP, "src-untouched.png");
  await run("ffmpeg", ["-y", "-i", videoPath, "-ss", "0.2", "-frames:v", "1", srcUntouchedPath]);
  const outUntouchedPath = path.join(TMP, "out-untouched.png");
  await run("ffmpeg", ["-y", "-i", outPath, "-ss", "0.2", "-frames:v", "1", outUntouchedPath]); // before kf1, so timeline hasn't diverged yet
  const srcUBuf = await sharp(srcUntouchedPath).raw().toBuffer();
  const outUBuf = await sharp(outUntouchedPath).raw().toBuffer();
  const untouchedDiff = meanAbsDiff(srcUBuf, outUBuf);
  console.log("    mean abs diff before kf1:", untouchedDiff.toFixed(2));
  assert(untouchedDiff < 2, "footage before the first keyframe is pixel-identical to the source");
  void untouchedT;

  console.log("\nALL KEYFRAMES-MODE CHECKS PASSED. Output:", outPath);
}

function fakePose() {
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
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
    <rect width="100%" height="100%" fill="black" />
    <ellipse cx="${WIDTH * 0.5}" cy="${HEIGHT * 0.5}" rx="${WIDTH * 0.16}" ry="${HEIGHT * 0.42}" fill="white" />
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function fakeAnatomyImage(color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
    <rect width="100%" height="100%" fill="black" />
    <ellipse cx="${WIDTH * 0.5}" cy="${HEIGHT * 0.5}" rx="${WIDTH * 0.16}" ry="${HEIGHT * 0.42}" fill="${color}" />
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function meanAbsDiff(a, b) {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) sum += Math.abs(a[i] - b[i]);
  return sum / n;
}

async function postJson(p, body) {
  const resp = await fetch(`${BASE}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return checkOk(resp);
}

async function getJson(p) {
  return checkOk(await fetch(`${BASE}${p}`));
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
  console.log("   ok:", msg);
}

main().catch((err) => {
  console.error("KEYFRAMES SMOKE TEST FAILED:", err);
  process.exit(1);
});
