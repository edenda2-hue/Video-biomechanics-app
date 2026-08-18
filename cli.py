#!/usr/bin/env python3
"""General-purpose CLI: any video, any pause point, any muscle subset.

Example (the Milestone 1 test case, once input/test_clip_1.mov exists):

    python3 cli.py \\
        --video input/test_clip_1.mov \\
        --pause-time 1.0 \\
        --freeze-duration 3.0 \\
        --muscles latissimus_dorsi_r latissimus_dorsi_l triceps_brachii_r \\
                  triceps_brachii_l rectus_abdominis gluteus_maximus_r \\
                  gluteus_maximus_l \\
        --output output/test_clip_1_annotated.mp4

Nothing above is hardcoded in the pipeline itself -- video path, pause
time, freeze duration, and muscle list are all just arguments.
"""
from __future__ import annotations

import argparse
import logging
import pathlib
import sys

from compositing.overlay import build_muscle_overlay
from muscle_library.library import MuscleLibrary
from pose.detector import PoseDetectionError, detect_pose_at_time
from video.segments import build_annotated_video


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--video", required=True, type=pathlib.Path, help="Path to any input video file")
    parser.add_argument("--pause-time", required=True, type=float, help="Seconds into the video to pause at")
    parser.add_argument("--freeze-duration", type=float, default=3.0, help="How long to hold the paused frame (s)")
    parser.add_argument("--fade-in", type=float, default=0.6, help="How long the muscle overlay takes to fade in (s)")
    parser.add_argument(
        "--muscles", required=True, nargs="+",
        help="Muscle ids from muscle_library/catalog.json, and/or group names "
             "(upper_body, core, lower_body, all)",
    )
    parser.add_argument("--output", required=True, type=pathlib.Path, help="Output video path")
    parser.add_argument("--model", type=pathlib.Path, default=None, help="Override pose model .task path")
    parser.add_argument("-v", "--verbose", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    logger = logging.getLogger("cli")

    library = MuscleLibrary.load()
    try:
        muscles = library.resolve(args.muscles)
    except KeyError as e:
        logger.error(str(e))
        return 1
    if not muscles:
        logger.error("No muscles resolved from --muscles %s", args.muscles)
        return 1
    logger.info("Selected %d muscle(s): %s", len(muscles), ", ".join(m.id for m in muscles))

    detect_kwargs = {}
    if args.model:
        detect_kwargs["model_path"] = args.model

    try:
        frame_bgr, pose_frame = detect_pose_at_time(args.video, args.pause_time, **detect_kwargs)
    except PoseDetectionError as e:
        logger.error("Pose detection failed: %s", e)
        return 1
    logger.info(
        "Pose detected at t=%.3fs (%dx%d), %d/%d landmarks visible >=0.5",
        pose_frame.timestamp_s, pose_frame.frame_width, pose_frame.frame_height,
        sum(1 for lm in pose_frame.landmarks.values() if lm.visibility >= 0.5),
        len(pose_frame.landmarks),
    )

    overlay = build_muscle_overlay(pose_frame, muscles)
    placeholder_count = sum(1 for m in muscles if not _asset_is_curated(m))
    if placeholder_count:
        logger.warning(
            "%d/%d selected muscles used placeholder art (no curated cutout yet) -- "
            "see assets/anatomy/README.md",
            placeholder_count, len(muscles),
        )

    build_annotated_video(
        video_path=args.video,
        pause_time_s=pose_frame.timestamp_s,
        freeze_duration_s=args.freeze_duration,
        frozen_frame_bgr=frame_bgr,
        overlay_rgba=overlay,
        output_path=args.output,
        fade_in_s=args.fade_in,
    )
    logger.info("Wrote %s", args.output)
    return 0


def _asset_is_curated(muscle) -> bool:
    from compositing.assets import ASSETS_DIR
    return (ASSETS_DIR / muscle.cutout_asset).exists() and (ASSETS_DIR / f"{muscle.id}.json").exists()


if __name__ == "__main__":
    sys.exit(main())
