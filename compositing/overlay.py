"""Ties assets + warp + occlusion together into one RGBA overlay for a
given pose frame and muscle selection, and composites it onto a video
frame. Generic over the muscle list -- callers pick whichever subset of
the library they want for this run."""
from __future__ import annotations

import logging

import cv2
import numpy as np

from compositing.assets import load_muscle_asset
from compositing.occlusion import resolve_opacity
from compositing.warp import warp_onto_canvas
from muscle_library.schema import MuscleDefinition
from pose.angles import estimate_torso_yaw_deg
from pose.types import PoseFrame

logger = logging.getLogger(__name__)


def _alpha_composite(base: np.ndarray, layer: np.ndarray) -> np.ndarray:
    """Standard "over" alpha composite of RGBA `layer` onto RGBA `base`."""
    base_a = base[..., 3:4].astype(np.float64) / 255.0
    layer_a = layer[..., 3:4].astype(np.float64) / 255.0
    out_a = layer_a + base_a * (1 - layer_a)
    with np.errstate(invalid="ignore", divide="ignore"):
        out_rgb = (
            layer[..., :3].astype(np.float64) * layer_a
            + base[..., :3].astype(np.float64) * base_a * (1 - layer_a)
        ) / np.clip(out_a, 1e-6, None)
    out = np.zeros_like(base)
    out[..., :3] = np.clip(out_rgb, 0, 255).astype(np.uint8)
    out[..., 3] = np.clip(out_a[..., 0] * 255, 0, 255).astype(np.uint8)
    return out


def build_muscle_overlay(pose_frame: PoseFrame, muscles: list[MuscleDefinition]) -> np.ndarray:
    """Returns an RGBA canvas (pose_frame.frame_height x frame_width) with
    every requested muscle warped into place and occlusion-aware opacity
    applied. Fully data-driven over `muscles` -- add/remove entries and
    this function's behavior changes accordingly, no code edits needed."""
    canvas_size = (pose_frame.frame_width, pose_frame.frame_height)
    overlay = np.zeros((pose_frame.frame_height, pose_frame.frame_width, 4), dtype=np.uint8)
    torso_yaw_deg = estimate_torso_yaw_deg(pose_frame)

    for muscle in muscles:
        missing = [n for n in muscle.anchor_landmarks if n not in pose_frame.landmarks]
        if missing:
            logger.warning("Skipping muscle '%s': landmarks not detected: %s", muscle.id, missing)
            continue

        target_points = [pose_frame.px(n) for n in muscle.anchor_landmarks]
        asset = load_muscle_asset(muscle)

        warped = warp_onto_canvas(asset.image_rgba, asset.control_points, target_points, canvas_size)

        opacity = resolve_opacity(muscle, torso_yaw_deg)
        warped = warped.copy()
        warped[..., 3] = (warped[..., 3].astype(np.float64) * opacity).astype(np.uint8)

        overlay = _alpha_composite(overlay, warped)

    return overlay


def composite_overlay_on_frame(frame_bgr: np.ndarray, overlay_rgba: np.ndarray, fade: float = 1.0) -> np.ndarray:
    """Alpha-blend `overlay_rgba` onto `frame_bgr` (BGR, no alpha), scaling
    the overlay's own alpha by `fade` in [0, 1] -- used to animate the
    fade-in when the video freezes on the paused frame."""
    fade = max(0.0, min(1.0, fade))
    frame_bgra = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2BGRA)
    scaled_overlay = overlay_rgba.copy()
    scaled_overlay[..., 3] = (scaled_overlay[..., 3].astype(np.float64) * fade).astype(np.uint8)
    composited = _alpha_composite(frame_bgra, scaled_overlay)
    return cv2.cvtColor(composited, cv2.COLOR_BGRA2BGR)
