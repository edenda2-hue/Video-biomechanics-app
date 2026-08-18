#!/usr/bin/env python3
"""Download the real MediaPipe Pose Landmarker model weights.

Run once before using the pipeline:
    python3 scripts/download_pose_model.py

The model is not committed to git (it's ~30MB of binary weights) — this
script fetches it from Google's official model hosting on demand.
"""
import argparse
import pathlib
import sys
import urllib.request

MODELS = {
    # Higher accuracy, slower — good default for single-frame analysis
    # (we only run inference on the one paused frame, not every frame of
    # the video, so the speed cost of "heavy" is negligible).
    "heavy": "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task",
    "full": "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task",
    "lite": "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
}

DEFAULT_DIR = pathlib.Path(__file__).resolve().parent.parent / "models"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--variant", choices=sorted(MODELS), default="heavy")
    parser.add_argument("--out-dir", type=pathlib.Path, default=DEFAULT_DIR)
    args = parser.parse_args()

    args.out_dir.mkdir(parents=True, exist_ok=True)
    url = MODELS[args.variant]
    dest = args.out_dir / f"pose_landmarker_{args.variant}.task"

    print(f"Downloading {url}\n  -> {dest}")
    urllib.request.urlretrieve(url, dest)
    size_mb = dest.stat().st_size / 1_000_000
    print(f"Done: {size_mb:.1f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
