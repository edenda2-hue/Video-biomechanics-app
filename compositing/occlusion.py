"""Generic occlusion / ghosting logic.

For any muscle, on any body, from any camera angle: decide how opaque its
overlay should render based on whether that muscle's side of the body is
facing the camera or turned away. This depends only on (a) the muscle's
declared surface_facing + laterality (metadata, not geometry) and (b) the
torso's estimated yaw for *this* frame (pose/angles.estimate_torso_yaw_deg)
-- never on which exercise or muscle set was requested.

Model: each surface_facing/laterality combination has a fixed outward
normal direction in the body's own reference frame (0 deg = anterior,
+/-90 deg = lateral right/left, 180 deg = posterior). Rotating that normal
by the estimated torso yaw and comparing it to the camera's fixed viewing
axis (cosine similarity) gives a continuous, physically-motivated facing
score -- the "angle between camera vector and body-surface normal" the
project brief asks for, without needing a full 3D body reconstruction.
"""
from __future__ import annotations

import math

from muscle_library.schema import Laterality, MuscleDefinition, SurfaceFacing

GHOST_OPACITY = 0.15
FULL_OPACITY = 0.88

_FACING_BASE_ANGLE_DEG = {
    SurfaceFacing.ANTERIOR: 0.0,
    SurfaceFacing.POSTERIOR: 180.0,
    SurfaceFacing.LATERAL: 90.0,  # sign resolved by laterality below
}


def _body_frame_normal_angle_deg(muscle: MuscleDefinition) -> float:
    base = _FACING_BASE_ANGLE_DEG[muscle.surface_facing]
    if muscle.surface_facing == SurfaceFacing.LATERAL and muscle.laterality == Laterality.LEFT:
        return -base
    return base


def facing_score(muscle: MuscleDefinition, torso_yaw_deg: float) -> float:
    """cos(angle) between the camera's viewing axis and this muscle's
    outward normal in the current frame. +1 = facing the camera directly,
    -1 = facing directly away (fully occluded by the body itself)."""
    normal_in_world_deg = _body_frame_normal_angle_deg(muscle) + torso_yaw_deg
    return math.cos(math.radians(normal_in_world_deg))


def resolve_opacity(muscle: MuscleDefinition, torso_yaw_deg: float) -> float:
    """Opacity in [GHOST_OPACITY, FULL_OPACITY] for this muscle at this
    torso orientation. Smoothly interpolated, not a hard on/off cutoff,
    so a muscle rotating from front-on to edge-on fades rather than pops."""
    score = facing_score(muscle, torso_yaw_deg)  # [-1, 1]
    normalized = max(0.0, min(1.0, (score + 1.0) / 2.0))  # [0, 1]
    shaped = normalized ** 0.6  # keep mid-range (edge-on) reasonably visible
    return GHOST_OPACITY + (FULL_OPACITY - GHOST_OPACITY) * shaped
