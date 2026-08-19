import { spawn } from "node:child_process";
import type { VideoMetadata } from "../types.js";

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
  return run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args]);
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
export async function encodeImageSequence(seqGlobPattern: string, fps: number, outPath: string) {
  await ffmpeg([
    "-framerate",
    String(fps),
    "-i",
    seqGlobPattern,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-crf",
    "16",
    outPath,
  ]);
}

export interface AssembleOptions {
  originalVideoPath: string;
  freezeSegmentPath: string;
  freezeSec: number;
  freezeDurationSec: number;
  metadata: VideoMetadata;
  outPath: string;
}

/**
 * Splices the generated freeze segment into the original video: everything
 * before and after `freezeSec` is the untouched original stream; only the
 * spliced-in window is new footage. Audio is held silent for the freeze
 * duration so audio/video stay in sync when the clip resumes, then the
 * original audio continues exactly where it left off.
 */
export async function assembleFinalVideo(opts: AssembleOptions) {
  const { originalVideoPath, freezeSegmentPath, freezeSec, freezeDurationSec, metadata, outPath } = opts;
  const bitrate = estimateBitrate(metadata);

  const filters: string[] = [
    `[0:v]trim=0:${freezeSec},setpts=PTS-STARTPTS[v0]`,
    `[1:v]setpts=PTS-STARTPTS[v1]`,
    `[0:v]trim=${freezeSec}:${metadata.durationSec},setpts=PTS-STARTPTS[v2]`,
    `[v0][v1][v2]concat=n=3:v=1:a=0[vout]`,
  ];

  const args = ["-i", originalVideoPath, "-i", freezeSegmentPath];

  if (metadata.hasAudio) {
    filters.push(
      `[0:a]atrim=0:${freezeSec},asetpts=PTS-STARTPTS[a0]`,
      `anullsrc=r=48000:cl=stereo:d=${freezeDurationSec}[asil]`,
      `[0:a]atrim=${freezeSec}:${metadata.durationSec},asetpts=PTS-STARTPTS[a2]`,
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

  await ffmpeg(args);
}

function estimateBitrate(metadata: VideoMetadata): string {
  // Keep it comfortably above typical source bitrates ("High Bitrate", spec section 15).
  const pixelsPerSec = metadata.width * metadata.height * metadata.fps;
  const mbps = Math.max(8, Math.min(40, pixelsPerSec / 2_000_000));
  return `${mbps.toFixed(1)}M`;
}
