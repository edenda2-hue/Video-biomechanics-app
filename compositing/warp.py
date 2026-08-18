"""Generic image warping: take a muscle cutout (with its own control
points) and deform it so those control points land on a target set of
pose-derived pixel coordinates, for *any* muscle and *any* pose — this
module has no notion of which muscle or exercise it's serving.

- >=3 control points: thin-plate spline (via scipy RBFInterpolator), which
  is what lets a flat anatomical illustration bend to follow a limb's
  actual angle in the frame instead of just scaling/rotating rigidly.
- exactly 2 control points: a similarity transform (rotate + uniform
  scale + translate) computed analytically, since TPS is undefined/
  degenerate below 3 points.
"""
from __future__ import annotations

import numpy as np
import cv2
from scipy.interpolate import RBFInterpolator


def _similarity_transform_matrix(src: np.ndarray, dst: np.ndarray) -> np.ndarray:
    """2x3 affine matrix mapping src[0]->dst[0], src[1]->dst[1] via a pure
    rotate+scale+translate (no shear) transform."""
    (sx0, sy0), (sx1, sy1) = src
    (dx0, dy0), (dx1, dy1) = dst

    src_vec = complex(sx1 - sx0, sy1 - sy0)
    dst_vec = complex(dx1 - dx0, dy1 - dy0)
    if abs(src_vec) < 1e-9:
        raise ValueError("Degenerate source control points (identical points)")
    scale_rot = dst_vec / src_vec  # complex number encodes scale * rotation

    a, b = scale_rot.real, scale_rot.imag
    # [x', y'] = [[a, -b], [b, a]] @ [x - sx0, y - sy0] + [dx0, dy0]
    m = np.array([
        [a, -b, dx0 - a * sx0 + b * sy0],
        [b, a, dy0 - b * sx0 - a * sy0],
    ], dtype=np.float64)
    return m


def warp_onto_canvas(
    source_rgba: np.ndarray,
    source_points: list[tuple[float, float]],
    target_points: list[tuple[float, float]],
    canvas_size: tuple[int, int],
    margin_px: float = 40.0,
) -> np.ndarray:
    """Warp `source_rgba` so its `source_points` land on `target_points`,
    returning an RGBA image of size canvas_size (width, height) with the
    warped muscle placed in the right spot and everything else transparent.
    """
    if len(source_points) != len(target_points):
        raise ValueError("source_points and target_points must be the same length")
    if len(source_points) < 2:
        raise ValueError("Need at least 2 control points to warp")

    canvas_w, canvas_h = canvas_size
    canvas = np.zeros((canvas_h, canvas_w, 4), dtype=np.uint8)

    tgt = np.array(target_points, dtype=np.float64)
    x_min = max(0, int(tgt[:, 0].min() - margin_px))
    x_max = min(canvas_w, int(tgt[:, 0].max() + margin_px))
    y_min = max(0, int(tgt[:, 1].min() - margin_px))
    y_max = min(canvas_h, int(tgt[:, 1].max() + margin_px))
    if x_max <= x_min or y_max <= y_min:
        return canvas  # target points collapsed to nothing on-canvas

    grid_x, grid_y = np.meshgrid(np.arange(x_min, x_max), np.arange(y_min, y_max))
    out_coords = np.stack([grid_x.ravel(), grid_y.ravel()], axis=1).astype(np.float64)

    if len(source_points) >= 3:
        src = np.array(source_points, dtype=np.float64)
        # Fit target -> source (inverse mapping), so we can sample source
        # pixels directly for every output pixel (avoids holes from a
        # forward warp).
        rbf_x = RBFInterpolator(tgt, src[:, 0], kernel="thin_plate_spline")
        rbf_y = RBFInterpolator(tgt, src[:, 1], kernel="thin_plate_spline")
        src_x = rbf_x(out_coords).reshape(grid_x.shape).astype(np.float32)
        src_y = rbf_y(out_coords).reshape(grid_y.shape).astype(np.float32)
    else:
        m_fwd = _similarity_transform_matrix(source_points, target_points)
        m_fwd3 = np.vstack([m_fwd, [0, 0, 1]])
        m_inv = np.linalg.inv(m_fwd3)[:2]
        ones = np.ones((out_coords.shape[0], 1))
        homo = np.hstack([out_coords, ones])
        src_pts = homo @ m_inv.T
        src_x = src_pts[:, 0].reshape(grid_x.shape).astype(np.float32)
        src_y = src_pts[:, 1].reshape(grid_y.shape).astype(np.float32)

    warped_patch = cv2.remap(
        source_rgba, src_x, src_y,
        interpolation=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(0, 0, 0, 0),
    )
    canvas[y_min:y_max, x_min:x_max] = warped_patch
    return canvas
