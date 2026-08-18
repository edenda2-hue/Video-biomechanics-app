"""Thin, generic ffmpeg/ffprobe wrappers -- no assumptions about resolution,
frame rate, duration, or codec of the input video."""
from __future__ import annotations

import json
import pathlib
import subprocess
from dataclasses import dataclass


class FfmpegError(RuntimeError):
    pass


@dataclass(frozen=True)
class VideoInfo:
    width: int
    height: int
    fps: float
    duration_s: float
    has_audio: bool


def probe(video_path: str | pathlib.Path) -> VideoInfo:
    cmd = [
        "ffprobe", "-v", "error", "-print_format", "json",
        "-show_streams", "-show_format", str(video_path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise FfmpegError(f"ffprobe failed for {video_path}:\n{proc.stderr}")
    data = json.loads(proc.stdout)

    video_stream = next((s for s in data["streams"] if s["codec_type"] == "video"), None)
    if video_stream is None:
        raise FfmpegError(f"No video stream found in {video_path}")
    has_audio = any(s["codec_type"] == "audio" for s in data["streams"])

    num, den = video_stream.get("avg_frame_rate", "0/1").split("/")
    fps = float(num) / float(den) if float(den) != 0 else 30.0

    duration_s = float(data["format"].get("duration", 0.0))
    return VideoInfo(
        width=int(video_stream["width"]),
        height=int(video_stream["height"]),
        fps=fps,
        duration_s=duration_s,
        has_audio=has_audio,
    )


def run(cmd: list[str]) -> None:
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise FfmpegError(f"Command failed: {' '.join(cmd)}\n{proc.stderr[-4000:]}")
