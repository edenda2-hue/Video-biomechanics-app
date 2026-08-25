import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { VideoMetadata } from "../types.js";

// On a single-vCPU instance (e.g. Render's Standard plan — 1 CPU), ffmpeg
// encoding a real video can occupy that one core heavily enough that the
// Node process gets starved of scheduling time it needs just to answer a
// trivial export-status poll, producing the same "job is fine, but the
// platform's proxy times out the poll" symptom the compositing loop used
// to cause before it was moved to native/non-blocking work — except this
// time it's OS-level CPU scheduling between two separate processes, not
// anything happening on Node's own event loop. `nice` lowers ffmpeg's
// scheduling priority so the kernel prefers giving CPU time to Node (which
// needs only brief bursts) over ffmpeg (which is happy to yield and
// resume) whenever they contend for the same core. Checked once at
// startup and skipped gracefully wherever unavailable (e.g. some Windows
// dev setups) rather than failing every ffmpeg call.
const NICE_AVAILABLE = spawnSync("nice", ["--version"]).error === undefined;

function spawnFfmpeg(args: string[]): ChildProcessWithoutNullStreams {
  return NICE_AVAILABLE ? spawn("nice", ["-n", "10", "ffmpeg", ...args]) : spawn("ffmpeg", args);
}

function run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited with code ${code}\n${stderr.slice(-4000)}`));
    });
  });
}

export function ffmpeg(args: string[]) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawnFfmpeg(["-y", "-hide_banner", "-loglevel", "error", ...args]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`ffmpeg exited with code ${code}\n${stderr.slice(-4000)}`));
    });
  });
}

/**
 * Same as ffmpeg(), but forces periodic "frame=" stats (via -stats, which
 * still prints even at -loglevel error) and parses them to report encoding
 * progress against an expected output frame count. Used for the two
 * multi-second ffmpeg passes in the export pipeline so the UI can show a
 * real progress bar instead of an indefinite spinner.
 */
export function ffmpegWithProgress(args: string[], expectedFrames: number, onProgress: (fraction: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnFfmpeg(["-y", "-hide_banner", "-loglevel", "error", "-stats", ...args]);
    let stderr = "";
    let buffer = "";
    const onData = (d: Buffer) => {
      const text = d.toString();
      stderr += text;
      buffer += text;
      const matches = [...buffer.matchAll(/frame=\s*(\d+)/g)];
      if (matches.length > 0) {
        const lastFrame = Number(matches[matches.length - 1][1]);
        onProgress(Math.min(1, expectedFrames > 0 ? lastFrame / expectedFrames : 0));
        buffer = buffer.slice(buffer.lastIndexOf(matches[matches.length - 1][0]));
      }
    };
    child.stderr.on("data", onData);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        onProgress(1);
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}\n${stderr.slice(-4000)}`));
      }
    });
  });
}

export function ffprobe(args: string[]) {
  return run("ffprobe", args);
}

/** Reads the immutable source-of-truth properties of the uploaded video (spec section 1). */
export async function probe(videoPath: string): Promise<VideoMetadata> {
  const { stdout } = await ffprobe([
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    videoPath,
  ]);
  const data = JSON.parse(stdout);
  const vStream = data.streams.find((s: any) => s.codec_type === "video");
  const aStream = data.streams.find((s: any) => s.codec_type === "audio");
  if (!vStream) throw new Error("No video stream found");

  const [num, den] = String(vStream.r_frame_rate ?? "25/1").split("/").map(Number);
  const fps = den ? num / den : num;
  const width = Number(vStream.width);
  const height = Number(vStream.height);
  const durationSec = Number(vStream.duration ?? data.format?.duration ?? 0);

  return {
    width,
    height,
    fps,
    durationSec,
    hasAudio: Boolean(aStream),
    codec: vStream.codec_name ?? "unknown",
    orientation: width === height ? "square" : width > height ? "landscape" : "portrait",
  };
}

/**
 * Extracts the exact frame at `timeSec` directly from the source video (never
 * regenerated), at full original resolution. This is the "source of truth"
 * frame used for every downstream anatomical/pose step.
 */
export async function extractFrame(videoPath: string, timeSec: number, outPngPath: string) {
  await ffmpeg([
    "-i",
    videoPath,
    "-ss",
    String(Math.max(0, timeSec)),
    "-frames:v",
    "1",
    outPngPath,
  ]);
}

/** Encodes a numbered PNG sequence (frame_00000.png, ...) into a silent H.264 video segment. */
export async function encodeImageSequence(
  seqGlobPattern: string,
  fps: number,
  outPath: string,
  progress?: { frameCount: number; onProgress: (fraction: number) => void },
) {
  const args = ["-framerate", String(fps), "-i", seqGlobPattern, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16", outPath];
  if (progress) {
    await ffmpegWithProgress(args, progress.frameCount, progress.onProgress);
  } else {
    await ffmpeg(args);
  }
}

export interface AssembleOptions {
  originalVideoPath: string;
  freezeSegmentPath: string;
  freezeSec: number;
  freezeDurationSec: number;
  /** Only [trimStartSec, trimEndSec] of the original video is kept; freezeSec must fall inside this range. */
  trimStartSec: number;
  trimEndSec: number;
  metadata: VideoMetadata;
  outPath: string;
}

/**
 * Splices the generated freeze segment into the (optionally trimmed)
 * original video: everything before and after `freezeSec`, within
 * [trimStartSec, trimEndSec], is the untouched original stream; only the
 * spliced-in window is new footage. Audio is held silent for the freeze
 * duration so audio/video stay in sync when the clip resumes, then the
 * original audio continues exactly where it left off.
 */
export async function assembleFinalVideo(opts: AssembleOptions, onProgress?: (fraction: number) => void) {
  const { originalVideoPath, freezeSegmentPath, freezeSec, freezeDurationSec, trimStartSec, trimEndSec, metadata, outPath } = opts;
  const bitrate = estimateBitrate(metadata);

  const filters: string[] = [
    `[0:v]trim=${trimStartSec}:${freezeSec},setpts=PTS-STARTPTS[v0]`,
    `[1:v]setpts=PTS-STARTPTS[v1]`,
    `[0:v]trim=${freezeSec}:${trimEndSec},setpts=PTS-STARTPTS[v2]`,
    `[v0][v1][v2]concat=n=3:v=1:a=0[vout]`,
  ];

  const args = ["-i", originalVideoPath, "-i", freezeSegmentPath];

  if (metadata.hasAudio) {
    filters.push(
      `[0:a]atrim=${trimStartSec}:${freezeSec},asetpts=PTS-STARTPTS[a0]`,
      `anullsrc=r=48000:cl=stereo:d=${freezeDurationSec}[asil]`,
      `[0:a]atrim=${freezeSec}:${trimEndSec},asetpts=PTS-STARTPTS[a2]`,
      `[a0][asil][a2]concat=n=3:v=0:a=1[aout]`,
    );
  }

  args.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[vout]",
    ...(metadata.hasAudio ? ["-map", "[aout]"] : ["-an"]),
    "-r",
    String(metadata.fps),
    "-c:v",
    "libx264",
    "-b:v",
    bitrate,
    "-pix_fmt",
    "yuv420p",
    ...(metadata.hasAudio ? ["-c:a", "aac", "-b:a", "192k"] : []),
    outPath,
  );

  const expectedFrames = Math.round((trimEndSec - trimStartSec + freezeDurationSec) * metadata.fps);
  if (onProgress) {
    await ffmpegWithProgress(args, expectedFrames, onProgress);
  } else {
    await ffmpeg(args);
  }
}

export interface MultiFreezeKeyframeSegment {
  timeSec: number;
  /** Encoded freeze segment for this keyframe (from buildFreezeSequence + encodeImageSequence). */
  segmentPath: string;
  holdDurationSec: number;
}

export interface AssembleMultiFreezeOptions {
  originalVideoPath: string;
  /** Sorted ascending by timeSec; each must fall within [trimStartSec, trimEndSec]. */
  keyframes: MultiFreezeKeyframeSegment[];
  trimStartSec: number;
  trimEndSec: number;
  metadata: VideoMetadata;
  outPath: string;
}

/**
 * "Anatomy Keyframes" mode's assembly: generalizes assembleFinalVideo's
 * single-splice pattern to N freeze points. Original footage plays
 * between/around every keyframe; each keyframe's freeze segment is spliced
 * in at its own timestamp, audio silenced only for that keyframe's own
 * hold duration and resuming the original track immediately after (same
 * audio-sync principle as the single-freeze flow, just repeated per
 * keyframe).
 */
export async function assembleMultiFreezeVideo(opts: AssembleMultiFreezeOptions, onProgress?: (fraction: number) => void) {
  const { originalVideoPath, keyframes, trimStartSec, trimEndSec, metadata, outPath } = opts;
  if (keyframes.length === 0) throw new Error("assembleMultiFreezeVideo requires at least one keyframe");
  const bitrate = estimateBitrate(metadata);

  const args = ["-i", originalVideoPath];
  keyframes.forEach((kf) => args.push("-i", kf.segmentPath));

  const vFilters: string[] = [];
  const vLabels: string[] = [];
  let cursor = trimStartSec;
  keyframes.forEach((kf, i) => {
    vFilters.push(`[0:v]trim=${cursor}:${kf.timeSec},setpts=PTS-STARTPTS[vo${i}]`);
    vLabels.push(`[vo${i}]`);
    vFilters.push(`[${i + 1}:v]setpts=PTS-STARTPTS[vf${i}]`);
    vLabels.push(`[vf${i}]`);
    cursor = kf.timeSec;
  });
  vFilters.push(`[0:v]trim=${cursor}:${trimEndSec},setpts=PTS-STARTPTS[voLast]`);
  vLabels.push(`[voLast]`);
  vFilters.push(`${vLabels.join("")}concat=n=${vLabels.length}:v=1:a=0[vout]`);

  const filters = [...vFilters];
  if (metadata.hasAudio) {
    const aFilters: string[] = [];
    const aLabels: string[] = [];
    cursor = trimStartSec;
    keyframes.forEach((kf, i) => {
      aFilters.push(`[0:a]atrim=${cursor}:${kf.timeSec},asetpts=PTS-STARTPTS[ao${i}]`);
      aLabels.push(`[ao${i}]`);
      aFilters.push(`anullsrc=r=48000:cl=stereo:d=${kf.holdDurationSec}[as${i}]`);
      aLabels.push(`[as${i}]`);
      cursor = kf.timeSec;
    });
    aFilters.push(`[0:a]atrim=${cursor}:${trimEndSec},asetpts=PTS-STARTPTS[aoLast]`);
    aLabels.push(`[aoLast]`);
    aFilters.push(`${aLabels.join("")}concat=n=${aLabels.length}:v=0:a=1[aout]`);
    filters.push(...aFilters);
  }

  args.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[vout]",
    ...(metadata.hasAudio ? ["-map", "[aout]"] : ["-an"]),
    "-r",
    String(metadata.fps),
    "-c:v",
    "libx264",
    "-b:v",
    bitrate,
    "-pix_fmt",
    "yuv420p",
    ...(metadata.hasAudio ? ["-c:a", "aac", "-b:a", "192k"] : []),
    outPath,
  );

  const totalHold = keyframes.reduce((sum, kf) => sum + kf.holdDurationSec, 0);
  const expectedFrames = Math.round((trimEndSec - trimStartSec + totalHold) * metadata.fps);
  if (onProgress) {
    await ffmpegWithProgress(args, expectedFrames, onProgress);
  } else {
    await ffmpeg(args);
  }
}

export interface AssembleContinuousOptions {
  originalVideoPath: string;
  /** Encoded video covering exactly [startSec, endSec] of output content (from buildContinuousSequence + encodeImageSequence). */
  continuousSegmentPath: string;
  startSec: number;
  endSec: number;
  trimStartSec: number;
  trimEndSec: number;
  metadata: VideoMetadata;
  outPath: string;
}

/**
 * Splices a continuous-mode segment into the (optionally trimmed) original
 * video: everything before `startSec` and after `endSec`, within
 * [trimStartSec, trimEndSec], is the untouched original stream; only
 * [startSec, endSec] is replaced with the puppet-composited footage. Unlike
 * the single-freeze flow, the replaced range keeps the *original* audio
 * unmodified throughout (no silence to splice in) since nothing here changes
 * playback timing — the puppet sequence covers the same duration and frame
 * rate as the video content it replaces.
 */
export async function assembleContinuousVideo(opts: AssembleContinuousOptions, onProgress?: (fraction: number) => void) {
  const { originalVideoPath, continuousSegmentPath, startSec, endSec, trimStartSec, trimEndSec, metadata, outPath } = opts;
  const bitrate = estimateBitrate(metadata);

  const filters: string[] = [
    `[0:v]trim=${trimStartSec}:${startSec},setpts=PTS-STARTPTS[v0]`,
    `[1:v]setpts=PTS-STARTPTS[v1]`,
    `[0:v]trim=${endSec}:${trimEndSec},setpts=PTS-STARTPTS[v2]`,
    `[v0][v1][v2]concat=n=3:v=1:a=0[vout]`,
  ];

  const args = ["-i", originalVideoPath, "-i", continuousSegmentPath];

  if (metadata.hasAudio) {
    filters.push(`[0:a]atrim=${trimStartSec}:${trimEndSec},asetpts=PTS-STARTPTS[aout]`);
  }

  args.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[vout]",
    ...(metadata.hasAudio ? ["-map", "[aout]"] : ["-an"]),
    "-r",
    String(metadata.fps),
    "-c:v",
    "libx264",
    "-b:v",
    bitrate,
    "-pix_fmt",
    "yuv420p",
    ...(metadata.hasAudio ? ["-c:a", "aac", "-b:a", "192k"] : []),
    outPath,
  );

  const expectedFrames = Math.round((trimEndSec - trimStartSec) * metadata.fps);
  if (onProgress) {
    await ffmpegWithProgress(args, expectedFrames, onProgress);
  } else {
    await ffmpeg(args);
  }
}

function estimateBitrate(metadata: VideoMetadata): string {
  // Keep it comfortably above typical source bitrates ("High Bitrate", spec section 15).
  const pixelsPerSec = metadata.width * metadata.height * metadata.fps;
  const mbps = Math.max(8, Math.min(40, pixelsPerSec / 2_000_000));
  return `${mbps.toFixed(1)}M`;
}
