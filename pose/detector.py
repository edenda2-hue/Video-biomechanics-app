"""MediaPipe Pose Landmarker wrapper.

Generic by construction: it takes a video path and a timestamp, and hands
back landmarks for whatever human is in whatever frame is there. Nothing
about a specific exercise, camera angle, or muscle selection appears here.
"""
from __future__ import annotations

import pathlib

import cv2
import numpy as np

from pose.types import LANDMARK_NAMES, Landmark, PoseFrame

DEFAULT_MODEL_PATH = pathlib.Path(__file__).resolve().parent.parent / "models" / "pose_landmarker_heavy.task"


class PoseDetectionError(RuntimeError):
    pass


def extract_frame_at_time(video_path: str | pathlib.Path, timestamp_s: float) -> tuple[np.ndarray, float, int]:
    """Grab the nearest video frame to `timestamp_s`.

    Returns (frame_bgr, actual_timestamp_s, fps). Raises PoseDetectionError
    if the timestamp is outside the video or the frame can't be read.
    """
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise PoseDetectionError(f"Could not open video: {video_path}")
    try:
        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        frame_count = cap.get(cv2.CAP_PROP_FRAME_COUNT)
        duration_s = frame_count / fps if fps else 0.0
        if timestamp_s < 0 or (duration_s and timestamp_s > duration_s):
            raise PoseDetectionError(
                f"pause_time={timestamp_s}s is outside the video duration (~{duration_s:.2f}s)"
            )
        cap.set(cv2.CAP_PROP_POS_MSEC, timestamp_s * 1000.0)
        ok, frame = cap.read()
        if not ok or frame is None:
            raise PoseDetectionError(f"Could not read a frame at {timestamp_s}s")
        actual_ms = cap.get(cv2.CAP_PROP_POS_MSEC)
        return frame, actual_ms / 1000.0, fps
    finally:
        cap.release()


def detect_pose(
    frame_bgr: np.ndarray,
    timestamp_s: float,
    model_path: str | pathlib.Path = DEFAULT_MODEL_PATH,
) -> PoseFrame:
    """Run MediaPipe Pose Landmarker on a single BGR frame and return a
    PoseFrame. Raises PoseDetectionError if no person is detected."""
    model_path = pathlib.Path(model_path)
    if not model_path.exists():
        raise PoseDetectionError(
            f"Pose model not found at {model_path}. "
            "Run: python3 scripts/download_pose_model.py"
        )

    # Imported lazily so importing this module doesn't require mediapipe's
    # tasks submodule unless detection actually runs.
    import mediapipe as mp
    from mediapipe.tasks import python as mp_python
    from mediapipe.tasks.python import vision as mp_vision

    base_options = mp_python.BaseOptions(model_asset_path=str(model_path))
    options = mp_vision.PoseLandmarkerOptions(
        base_options=base_options,
        running_mode=mp_vision.RunningMode.IMAGE,
        num_poses=1,
        min_pose_detection_confidence=0.5,
        min_pose_presence_confidence=0.5,
    )

    frame_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=frame_rgb)

    with mp_vision.PoseLandmarker.create_from_options(options) as landmarker:
        result = landmarker.detect(mp_image)

    if not result.pose_landmarks:
        raise PoseDetectionError(
            "No person detected in the frame at the requested timestamp. "
            "Try a nearby timestamp, or verify the subject is fully visible."
        )

    raw_landmarks = result.pose_landmarks[0]  # num_poses=1
    height, width = frame_bgr.shape[:2]
    landmarks = {
        LANDMARK_NAMES[i]: Landmark(x=lm.x, y=lm.y, z=lm.z, visibility=lm.visibility)
        for i, lm in enumerate(raw_landmarks)
    }
    return PoseFrame(frame_width=width, frame_height=height, timestamp_s=timestamp_s, landmarks=landmarks)


def detect_pose_at_time(
    video_path: str | pathlib.Path,
    timestamp_s: float,
    model_path: str | pathlib.Path = DEFAULT_MODEL_PATH,
) -> tuple[np.ndarray, PoseFrame]:
    """Convenience: extract the frame at `timestamp_s` and run pose
    detection on it in one call. Returns (frame_bgr, PoseFrame)."""
    frame_bgr, actual_ts, _fps = extract_frame_at_time(video_path, timestamp_s)
    pose_frame = detect_pose(frame_bgr, actual_ts, model_path=model_path)
    return frame_bgr, pose_frame
