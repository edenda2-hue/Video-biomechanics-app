// End-to-end smoke test for "Anatomy Slides" mode: a full-frame anatomy
// slide at t=0 (the opening-card edge case — no original footage precedes
// it, which is the one thing this mode's reuse of assembleMultiFreezeVideo
// needed verifying for, since that function was written for Anatomy
// Keyframes where a keyframe at exactly t=0 was never actually exercised)
// plus a second slide mid-video, spliced into one output. Drives the real
// HTTP API against a synthetic test video, mirroring keyframes-smoke.mjs.
// Run with the server up: node scripts/slides-smoke.mjs
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

const TMP = "/tmp/vba-slides-smoke";

async function main() {
  await fs.mkdir(TMP, { recursive: true });
  const videoPath = path.join(TMP, "source.mp4");
  console.log("1. generating synthetic test video (solid dark blue)...");
  await run("ffmpeg", [
    "-y", "-f", "lavfi", "-i", `color=c=0x2244AA:s=${WIDTH}x${HEIGHT}:rate=${FPS}:duration=${DURATION}`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${DURATION}`,
    "-pix_fmt", "yuv420p", "-c:a", "aac", videoPath,
  ]);

  console.log("2. creating session...");
  const form = new FormData();
  form.append("video", new Blob([await fs.readFile(videoPath)], { type: "video/mp4" }), "source.mp4");
  const created = await postForm("/sessions", form);
  const sessionId = created.id;
  console.log("   session:", sessionId, created.metadata);

  console.log("3. adding an OPENING slide at t=0 and a mid-video slide at t=3.0s...");
  const slide1 = await postJson(`/sessions/${sessionId}/slides`, { timeSec: 0 });
  const slide2 = await postJson(`/sessions/${sessionId}/slides`, { timeSec: 3.0 });
  console.log("   opening slide:", slide1.id, "mid-video slide:", slide2.id);

  console.log("4. downloading the opening slide's extracted frame...");
  const frameResp = await fetch(`${new URL(BASE).origin}${slide1.frameUrl}`);
  await checkOk(frameResp);
  const frameBuf = Buffer.from(await frameResp.arrayBuffer());
  assert(frameBuf.length > 0, "opening slide's frame is downloadable and non-empty");

  console.log("5. uploading a distinct solid-color anatomy image for each slide...");
  const anatomy1 = (await fakeAnatomyImage("#FF00FF")).toString("base64"); // magenta = opening
  const anatomy2 = (await fakeAnatomyImage("#FFA500")).toString("base64"); // orange = mid-video
  await postJson(`/sessions/${sessionId}/slides/${slide1.id}/anatomy`, { imagePngBase64: `data:image/png;base64,${anatomy1}` });
  await postJson(`/sessions/${sessionId}/slides/${slide2.id}/anatomy`, { imagePngBase64: `data:image/png;base64,${anatomy2}` });

  console.log("6. setting short hold/transition durations for a faster test...");
  await fetch(`${BASE}/sessions/${sessionId}/slides/${slide1.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ holdDurationSec: 2, transitionInSec: 0.3, transitionOutSec: 0.3 }),
  }).then(checkOk);
  await fetch(`${BASE}/sessions/${sessionId}/slides/${slide2.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ holdDurationSec: 2, transitionInSec: 0.3, transitionOutSec: 0.3 }),
  }).then(checkOk);

  console.log("7. starting the slides export job...");
  const started = await postJson(`/sessions/${sessionId}/slides/export`, {});
  console.log("   ", started);

  console.log("7b. polling export status until done...");
  let job;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    job = await getJson(`/sessions/${sessionId}/slides/export/status`);
    if (job.phase === "done" || job.phase === "error") break;
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log("   final job status:", job);
  assert(job.phase === "done", `export completed successfully (got: ${job.phase} - ${job.error ?? ""})`);

  const outPath = path.join(TMP, "slides_export.mp4");
  const resp = await fetch(`${BASE}/sessions/${sessionId}/slides/export/file`);
  await checkOk(resp);
  await fs.writeFile(outPath, Buffer.from(await resp.arrayBuffer()));

  console.log("8. verifying with ffprobe...");
  const { stdout } = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", outPath]);
  const probe = JSON.parse(stdout);
  const v = probe.streams.find((s) => s.codec_type === "video");
  console.log("    video:", v.width, "x", v.height, v.r_frame_rate, "duration:", probe.format.duration);
  assert(Number(v.width) === WIDTH && Number(v.height) === HEIGHT, "export resolution matches the source");
  // original duration + slide1's hold (2s) + slide2's hold (2s)
  const expectedDuration = DURATION + 2 + 2;
  assert(Math.abs(Number(probe.format.duration) - expectedDuration) < 0.5, `export duration ~= ${expectedDuration}s (2 slide holds spliced in)`);

  console.log("9. verifying the export literally OPENS on the anatomy slide (t=0 edge case)...");
  const openFramePath = path.join(TMP, "open-frame.png");
  await run("ffmpeg", ["-y", "-i", outPath, "-ss", "1.0", "-frames:v", "1", openFramePath]); // well inside the 2s opening hold
  const openBuf = await sharp(openFramePath).raw().toBuffer();
  const openIsMagenta = isRoughlyColor(openBuf, [255, 0, 255]);
  console.log("    frame at t=1.0s is magenta (opening slide)?", openIsMagenta);
  assert(openIsMagenta, "the video opens on the magenta opening slide, not the original footage");

  console.log("10. verifying it fades back into the real (blue) footage after the opening slide...");
  const afterOpenPath = path.join(TMP, "after-open-frame.png");
  await run("ffmpeg", ["-y", "-i", outPath, "-ss", "2.5", "-frames:v", "1", afterOpenPath]); // past the 2s hold + 0.3s transition-out
  const afterOpenBuf = await sharp(afterOpenPath).raw().toBuffer();
  const afterIsBlue = isRoughlyColor(afterOpenBuf, [0x22, 0x44, 0xaa]);
  console.log("    frame at t=2.5s is the original blue footage?", afterIsBlue);
  assert(afterIsBlue, "the video correctly resumes the original footage after the opening slide");

  console.log("11. verifying the mid-video slide shows its own distinct (orange) anatomy image...");
  // slide2 is at original t=3.0s; opening slide's 2s hold shifts the output
  // timeline forward by 2s, so slide2's hold starts at output t = 2 (opening hold) + 3.0 (resumed playback to reach slide2's point) = 5.0s.
  const midFramePath = path.join(TMP, "mid-frame.png");
  await run("ffmpeg", ["-y", "-i", outPath, "-ss", "6.0", "-frames:v", "1", midFramePath]); // well inside slide2's hold
  const midBuf = await sharp(midFramePath).raw().toBuffer();
  const midIsOrange = isRoughlyColor(midBuf, [255, 165, 0]);
  console.log("    frame at t=6.0s is orange (mid-video slide)?", midIsOrange);
  assert(midIsOrange, "the mid-video slide shows its own distinct anatomy image");

  console.log("\nALL SLIDES-MODE CHECKS PASSED. Output:", outPath);
}

function isRoughlyColor(rawBuf, [r, g, b], tolerance = 30) {
  // Sample the center pixel (raw buffer, 3 channels, no header — width/height not needed for a single ratio-independent center sample of a solid-color frame).
  const mid = Math.floor(rawBuf.length / 2 / 3) * 3;
  const pr = rawBuf[mid];
  const pg = rawBuf[mid + 1];
  const pb = rawBuf[mid + 2];
  return Math.abs(pr - r) < tolerance && Math.abs(pg - g) < tolerance && Math.abs(pb - b) < tolerance;
}

async function fakeAnatomyImage(color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}"><rect width="100%" height="100%" fill="${color}" /></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
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
  console.error("SLIDES SMOKE TEST FAILED:", err);
  process.exit(1);
});
