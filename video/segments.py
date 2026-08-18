"""Builds the 3-segment output video, generically over any input video,
pause time, freeze duration, and pre-built overlay:

  segment 1: original video, [0, pause_time]
  segment 2: frozen frame at pause_time, held for freeze_duration, with
             the muscle overlay fading in over fade_in_s and then holding
  segment 3: original video, [pause_time, end]

All three are re-encoded to a common codec/resolution/fps/pixel format
(taken from the source video via ffprobe) so the concat demuxer can join
them regardless of the input's original codec.
"""
from __future__ import annotations

import pathlib
import shutil
import tempfile

import cv2
import numpy as np

from compositing.overlay import composite_overlay_on_frame
from video.ffmpeg_utils import VideoInfo, probe, run

_COMMON_VIDEO_ARGS = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "18"]
_COMMON_AUDIO_ARGS = ["-c:a", "aac", "-ar", "44100", "-ac", "2"]


def _build_segment_1(video_path: pathlib.Path, pause_time_s: float, info: VideoInfo, out_path: pathlib.Path) -> None:
    cmd = ["ffmpeg", "-y", "-i", str(video_path), "-t", f"{pause_time_s:.6f}"]
    cmd += _COMMON_VIDEO_ARGS + ["-r", f"{info.fps:.6f}"]
    cmd += (_COMMON_AUDIO_ARGS if info.has_audio else ["-an"])
    cmd += [str(out_path)]
    run(cmd)


def _build_segment_3(video_path: pathlib.Path, pause_time_s: float, info: VideoInfo, out_path: pathlib.Path) -> None:
    cmd = ["ffmpeg", "-y", "-ss", f"{pause_time_s:.6f}", "-i", str(video_path)]
    cmd += _COMMON_VIDEO_ARGS + ["-r", f"{info.fps:.6f}"]
    cmd += (_COMMON_AUDIO_ARGS if info.has_audio else ["-an"])
    cmd += [str(out_path)]
    run(cmd)


def _build_segment_2_freeze(
    frozen_frame_bgr: np.ndarray,
    overlay_rgba: np.ndarray,
    info: VideoInfo,
    freeze_duration_s: float,
    fade_in_s: float,
    out_path: pathlib.Path,
    work_dir: pathlib.Path,
) -> None:
    frame_count = max(1, round(freeze_duration_s * info.fps))
    fade_frame_count = max(1, round(fade_in_s * info.fps))

    frames_dir = work_dir / "freeze_frames"
    frames_dir.mkdir(exist_ok=True)
    for i in range(frame_count):
        fade = min(1.0, i / fade_frame_count) if fade_frame_count > 0 else 1.0
        composited = composite_overlay_on_frame(frozen_frame_bgr, overlay_rgba, fade=fade)
        cv2.imwrite(str(frames_dir / f"frame_{i:05d}.png"), composited)

    cmd = ["ffmpeg", "-y", "-framerate", f"{info.fps:.6f}", "-i", str(frames_dir / "frame_%05d.png")]
    cmd += _COMMON_VIDEO_ARGS + ["-r", f"{info.fps:.6f}"]
    if info.has_audio:
        cmd = ["ffmpeg", "-y", "-framerate", f"{info.fps:.6f}", "-i", str(frames_dir / "frame_%05d.png"),
               "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo"]
        cmd += _COMMON_VIDEO_ARGS + ["-r", f"{info.fps:.6f}"]
        cmd += _COMMON_AUDIO_ARGS + ["-shortest"]
    cmd += [str(out_path)]
    run(cmd)


def build_annotated_video(
    video_path: str | pathlib.Path,
    pause_time_s: float,
    freeze_duration_s: float,
    frozen_frame_bgr: np.ndarray,
    overlay_rgba: np.ndarray,
    output_path: str | pathlib.Path,
    fade_in_s: float = 0.6,
) -> None:
    video_path = pathlib.Path(video_path)
    output_path = pathlib.Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    info = probe(video_path)
    if not (0 <= pause_time_s <= info.duration_s):
        raise ValueError(f"pause_time_s={pause_time_s} outside video duration ({info.duration_s:.2f}s)")

    with tempfile.TemporaryDirectory(prefix="biomech_segments_") as tmp:
        work_dir = pathlib.Path(tmp)
        seg1 = work_dir / "seg1.mp4"
        seg2 = work_dir / "seg2.mp4"
        seg3 = work_dir / "seg3.mp4"

        _build_segment_1(video_path, pause_time_s, info, seg1)
        _build_segment_2_freeze(frozen_frame_bgr, overlay_rgba, info, freeze_duration_s, fade_in_s, seg2, work_dir)
        _build_segment_3(video_path, pause_time_s, info, seg3)

        concat_list = work_dir / "concat.txt"
        concat_list.write_text("".join(f"file '{p}'\n" for p in (seg1, seg2, seg3)), encoding="utf-8")

        run([
            "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(concat_list),
            "-c", "copy", str(output_path),
        ])
