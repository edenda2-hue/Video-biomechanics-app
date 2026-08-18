"""Generic image warping: take a muscle cutout (with its own control
points) and deform it so those control points land on a target set of
pose-derived pixel coordinates, for *any* muscle and *any* pose — this
module has no notion of which muscle or exercise it's serving.

- >=3 well-spread control points: thin-plate spline (via scipy
  RBFInterpolator), which is what lets a flat anatomical illustration bend
  to follow a limb's actual angle in the frame instead of just
  scaling/rotating rigidly.
- exactly 2 control points, OR >=3 points that are (nearly) collinear: a
  similarity transform (rotate + uniform scale + translate, no shear/
  stretch) fit over all the points via cv2.estimateAffinePartial2D. TPS is
  numerically well-defined for collinear points, but it extrapolates
  wildly for any source content off that line -- exactly the case for a
  muscle spanning a fully straightened limb (e.g. triceps on an extended
  arm: shoulder/elbow/wrist all fall on ~one line), where it was observed
  to shred the source image into repeated stretched strips. Falling back
  to a rigid similarity transform whenever the points don't meaningfully
  span 2D space avoids that failure mode for any muscle/pose combination.
"""
from __future__ import annotations

import numpy as np
import cv2
from scipy.interpolate import RBFInterpolator

# Ratio of minor-to-major spread (via PCA) below which a point set is
# treated as "collinear enough" that TPS's off-line extrapolation can't be
# trusted, and a rigid similarity transform is used instead.
_COLLINEARITY_RATIO = 0.12


def _is_nearly_collinear(points: np.ndarray) -> bool:
    if len(points) < 3:
        return True
    centered = points - points.mean(axis=0)
    singular_values = np.linalg.svd(centered, compute_uv=False)
    if singular_values[0] < 1e-9:
        return True
    return (singular_values[1] / singular_values[0]) < _COLLINEARITY_RATIO


def _similarity_transform_matrix(src: np.ndarray, dst: np.ndarray) -> np.ndarray:
    """2x3 affine matrix mapping src->dst via a pure rotate+scale+translate
    (no shear) transform, least-squares fit over all point pairs (Umeyama's
    method -- a closed-form exact fit, unlike cv2.estimateAffinePartial2D's
    RANSAC/LMEDS estimators, which assume many points with outliers and
    misbehave on a handful of clean control points)."""
    n = len(src)
    mu_src, mu_dst = src.mean(axis=0), dst.mean(axis=0)
    src_c, dst_c = src - mu_src, dst - mu_dst

    var_src = (src_c ** 2).sum() / n
    if var_src < 1e-9:
        raise ValueError("Degenerate source control points (all coincide)")

    cov = (dst_c.T @ src_c) / n
    u, d, vt = np.linalg.svd(cov)
    s = np.eye(2)
    if np.linalg.det(u) * np.linalg.det(vt) < 0:
        s[1, 1] = -1
    rotation = u @ s @ vt
    scale = np.trace(np.diag(d) @ s) / var_src
    translation = mu_dst - scale * rotation @ mu_src

    return np.array([
        [scale * rotation[0, 0], scale * rotation[0, 1], translation[0]],
        [scale * rotation[1, 0], scale * rotation[1, 1], translation[1]],
    ], dtype=np.float64)


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

    src = np.array(source_points, dtype=np.float64)
    use_tps = len(source_points) >= 3 and not _is_nearly_collinear(src) and not _is_nearly_collinear(tgt)

    if use_tps:
        # Fit target -> source (inverse mapping), so we can sample source
        # pixels directly for every output pixel (avoids holes from a
        # forward warp).
        rbf_x = RBFInterpolator(tgt, src[:, 0], kernel="thin_plate_spline")
        rbf_y = RBFInterpolator(tgt, src[:, 1], kernel="thin_plate_spline")
        src_x = rbf_x(out_coords).reshape(grid_x.shape).astype(np.float32)
        src_y = rbf_y(out_coords).reshape(grid_y.shape).astype(np.float32)
    else:
        m_fwd = _similarity_transform_matrix(src, tgt)
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
