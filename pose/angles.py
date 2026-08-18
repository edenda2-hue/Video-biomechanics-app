"""Generic joint-angle and body-orientation math. Nothing here is specific
to any exercise — it's plain vector geometry over whatever landmarks a
PoseFrame happens to contain."""
from __future__ import annotations

import math

from pose.types import JOINT_ANGLE_DEFINITIONS, PoseFrame


def _angle_at_vertex(a: tuple[float, float], vertex: tuple[float, float], c: tuple[float, float]) -> float:
    """Angle in degrees at `vertex`, between rays vertex->a and vertex->c."""
    v1 = (a[0] - vertex[0], a[1] - vertex[1])
    v2 = (c[0] - vertex[0], c[1] - vertex[1])
    dot = v1[0] * v2[0] + v1[1] * v2[1]
    mag1 = math.hypot(*v1)
    mag2 = math.hypot(*v2)
    if mag1 < 1e-9 or mag2 < 1e-9:
        return float("nan")
    cos_theta = max(-1.0, min(1.0, dot / (mag1 * mag2)))
    return math.degrees(math.acos(cos_theta))


def compute_joint_angles(frame: PoseFrame) -> dict[str, float]:
    """All joint angles this frame's landmarks support, in degrees.
    Missing/low-visibility landmarks simply skip that joint rather than
    erroring — the caller decides what's usable."""
    angles: dict[str, float] = {}
    for joint_name, (a_name, vertex_name, c_name) in JOINT_ANGLE_DEFINITIONS.items():
        if not all(n in frame.landmarks for n in (a_name, vertex_name, c_name)):
            continue
        if min(frame.landmarks[n].visibility for n in (a_name, vertex_name, c_name)) < 0.3:
            continue
        angles[joint_name] = _angle_at_vertex(frame.px(a_name), frame.px(vertex_name), frame.px(c_name))
    return angles


def estimate_torso_yaw_deg(frame: PoseFrame) -> float:
    """Rough estimate of how much the torso is rotated around the vertical
    (camera-facing) axis, using the relative depth (z) of the two
    shoulders. 0 degrees = shoulders square to the camera (both shoulders
    at equal depth); +/-90 degrees = torso turned side-on.

    This is a coarse, generic proxy — not a true 3D reconstruction — but
    it's exactly the kind of camera-vs-body-surface signal the occlusion
    module needs, and it works for any exercise/camera angle since it only
    depends on two always-tracked landmarks.
    """
    left = frame.landmarks.get("LEFT_SHOULDER")
    right = frame.landmarks.get("RIGHT_SHOULDER")
    if left is None or right is None:
        return 0.0
    dx_px = (right.x - left.x) * frame.frame_width
    # z is in the same normalized scale as x for MediaPipe Pose World/Image
    # landmarks; scale by frame_width to bring it to comparable pixel units.
    dz_px = (right.z - left.z) * frame.frame_width
    if abs(dx_px) < 1e-6 and abs(dz_px) < 1e-6:
        return 0.0
    return math.degrees(math.atan2(dz_px, dx_px))
