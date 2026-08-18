"""Loads a muscle's source image + control points, for any muscle in the
library. Two paths:

1. Curated cutout exists: assets/anatomy/muscles/<cutout_asset> (RGBA PNG,
   transparent background, isolated muscle belly cut from a Gray's
   Anatomy 1918 plate) plus a sidecar assets/anatomy/muscles/<id>.json
   giving pixel-space control points in the same order as the muscle's
   anchor_landmarks.

2. No curated cutout yet: a procedurally generated placeholder — a soft,
   fiber-streaked blob, watermarked "PLACEHOLDER" — so the rest of the
   pipeline (warp/occlusion/compositing/video) is fully exercisable before
   real assets exist. This is explicitly NOT the final visual quality bar
   (see project brief: vector-drawn muscle shapes were already rejected as
   not organic-looking) — it exists only to prove the pipeline is wired
   correctly, and every placeholder use is logged.
"""
from __future__ import annotations

import json
import logging
import pathlib

import numpy as np
import cv2

from muscle_library.schema import MuscleDefinition

logger = logging.getLogger(__name__)

ASSETS_DIR = pathlib.Path(__file__).resolve().parent.parent / "assets" / "anatomy" / "muscles"

PLACEHOLDER_SIZE = 260  # px, square canvas the placeholder is drawn on


class MuscleAsset:
    def __init__(self, image_rgba: np.ndarray, control_points: list[tuple[float, float]], is_placeholder: bool):
        self.image_rgba = image_rgba
        self.control_points = control_points
        self.is_placeholder = is_placeholder


def _generate_placeholder(muscle: MuscleDefinition) -> MuscleAsset:
    n = PLACEHOLDER_SIZE
    canvas = np.zeros((n, n, 4), dtype=np.uint8)

    rng = np.random.default_rng(abs(hash(muscle.id)) % (2**32))
    cx, cy = n / 2, n / 2
    rx, ry = n * 0.28, n * 0.42

    yy, xx = np.mgrid[0:n, 0:n]
    ellipse = ((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2
    base_alpha = np.clip(1.0 - ellipse, 0, 1) ** 0.7

    # Fiber striations: soft sinusoidal streaks along the long axis, to at
    # least hint at directionality rather than a flat blob.
    streaks = 0.85 + 0.15 * np.sin(xx / n * 28 + rng.uniform(0, 6.28))
    muscle_red = np.array([60, 60, 178], dtype=np.float64)  # BGR, muscle-ish red
    color = np.clip(muscle_red[None, None, :] * streaks[..., None], 0, 255)

    canvas[..., 0] = color[..., 0]
    canvas[..., 1] = color[..., 1]
    canvas[..., 2] = color[..., 2]
    canvas[..., 3] = (base_alpha * 200).astype(np.uint8)  # capped alpha: never fully opaque, marks it as a stand-in

    cv2.putText(canvas, "PLACEHOLDER", (int(n * 0.06), int(n * 0.52)), cv2.FONT_HERSHEY_SIMPLEX,
                0.32, (255, 255, 255, 160), 1, cv2.LINE_AA)

    # Control points spaced along the vertical (long) axis of the ellipse,
    # matching however many anchor_landmarks this muscle declares.
    k = len(muscle.anchor_landmarks)
    top, bottom = cy - ry * 0.85, cy + ry * 0.85
    if k == 1:
        ys = [cy]
    else:
        ys = [top + (bottom - top) * i / (k - 1) for i in range(k)]
    control_points = [(cx, y) for y in ys]

    logger.warning(
        "No curated cutout for muscle '%s' (%s) -- rendering a placeholder shape. "
        "See assets/anatomy/README.md to populate the real asset.",
        muscle.id, muscle.name,
    )
    return MuscleAsset(canvas, control_points, is_placeholder=True)


def load_muscle_asset(muscle: MuscleDefinition, assets_dir: pathlib.Path = ASSETS_DIR) -> MuscleAsset:
    image_path = assets_dir / muscle.cutout_asset
    sidecar_path = assets_dir / f"{muscle.id}.json"

    if not image_path.exists() or not sidecar_path.exists():
        return _generate_placeholder(muscle)

    image_bgra = cv2.imread(str(image_path), cv2.IMREAD_UNCHANGED)
    if image_bgra is None or image_bgra.shape[2] != 4:
        logger.warning("Cutout for '%s' at %s is missing an alpha channel -- using placeholder", muscle.id, image_path)
        return _generate_placeholder(muscle)

    sidecar = json.loads(sidecar_path.read_text(encoding="utf-8"))
    control_points = [tuple(p) for p in sidecar["control_points"]]
    if len(control_points) != len(muscle.anchor_landmarks):
        raise ValueError(
            f"{sidecar_path} has {len(control_points)} control points but muscle "
            f"'{muscle.id}' declares {len(muscle.anchor_landmarks)} anchor_landmarks"
        )
    return MuscleAsset(image_bgra, control_points, is_placeholder=False)
