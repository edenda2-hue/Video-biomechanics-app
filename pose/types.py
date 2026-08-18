"""Shared types for pose data. Kept independent of the MediaPipe API surface
so the rest of the pipeline (muscle_library, compositing, video) never
imports mediapipe directly — only pose/detector.py does."""
from __future__ import annotations

from dataclasses import dataclass

# MediaPipe Pose's 33 landmarks, in the index order the model outputs them.
# https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker
LANDMARK_NAMES = [
    "NOSE", "LEFT_EYE_INNER", "LEFT_EYE", "LEFT_EYE_OUTER",
    "RIGHT_EYE_INNER", "RIGHT_EYE", "RIGHT_EYE_OUTER",
    "LEFT_EAR", "RIGHT_EAR", "MOUTH_LEFT", "MOUTH_RIGHT",
    "LEFT_SHOULDER", "RIGHT_SHOULDER", "LEFT_ELBOW", "RIGHT_ELBOW",
    "LEFT_WRIST", "RIGHT_WRIST", "LEFT_PINKY", "RIGHT_PINKY",
    "LEFT_INDEX", "RIGHT_INDEX", "LEFT_THUMB", "RIGHT_THUMB",
    "LEFT_HIP", "RIGHT_HIP", "LEFT_KNEE", "RIGHT_KNEE",
    "LEFT_ANKLE", "RIGHT_ANKLE", "LEFT_HEEL", "RIGHT_HEEL",
    "LEFT_FOOT_INDEX", "RIGHT_FOOT_INDEX",
]
LANDMARK_INDEX = {name: i for i, name in enumerate(LANDMARK_NAMES)}

# (joint_name, (point_a, vertex, point_c)) -- angle at `vertex` between rays
# vertex->point_a and vertex->point_c. Covers every major joint generically;
# which ones matter for a given clip is decided at analysis time, not here.
JOINT_ANGLE_DEFINITIONS = {
    "left_elbow": ("LEFT_SHOULDER", "LEFT_ELBOW", "LEFT_WRIST"),
    "right_elbow": ("RIGHT_SHOULDER", "RIGHT_ELBOW", "RIGHT_WRIST"),
    "left_shoulder": ("LEFT_ELBOW", "LEFT_SHOULDER", "LEFT_HIP"),
    "right_shoulder": ("RIGHT_ELBOW", "RIGHT_SHOULDER", "RIGHT_HIP"),
    "left_hip": ("LEFT_SHOULDER", "LEFT_HIP", "LEFT_KNEE"),
    "right_hip": ("RIGHT_SHOULDER", "RIGHT_HIP", "RIGHT_KNEE"),
    "left_knee": ("LEFT_HIP", "LEFT_KNEE", "LEFT_ANKLE"),
    "right_knee": ("RIGHT_HIP", "RIGHT_KNEE", "RIGHT_ANKLE"),
    "left_ankle": ("LEFT_KNEE", "LEFT_ANKLE", "LEFT_FOOT_INDEX"),
    "right_ankle": ("RIGHT_KNEE", "RIGHT_ANKLE", "RIGHT_FOOT_INDEX"),
}


@dataclass(frozen=True)
class Landmark:
    x: float  # normalized [0, 1], image space
    y: float  # normalized [0, 1], image space
    z: float  # roughly hip-depth-relative, MediaPipe's own scale; more
    # negative = closer to camera. Not metric, but consistent enough
    # within one frame to compare landmarks against each other.
    visibility: float  # [0, 1] model confidence this point isn't occluded


@dataclass(frozen=True)
class PoseFrame:
    frame_width: int
    frame_height: int
    timestamp_s: float
    landmarks: dict[str, Landmark]  # keyed by LANDMARK_NAMES entries

    def px(self, name: str) -> tuple[float, float]:
        """Landmark position in pixel coordinates."""
        lm = self.landmarks[name]
        return lm.x * self.frame_width, lm.y * self.frame_height
