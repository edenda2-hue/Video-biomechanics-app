#!/usr/bin/env python3
"""Turn a panel crop from a reference anatomy illustration sheet into a
transparent-background muscle-only cutout, by keying on saturation: muscle
tissue in these illustrations is a saturated red/salmon, while background,
labels, bone, and tendon are all low-saturation (white/pale/gray/black).
Not a general-purpose segmenter -- tuned for this style of illustration.

Usage:
    python3 scripts/segment_muscle_from_reference.py \\
        --in /tmp/anatomy_src/panel1_lat.png --out /tmp/anatomy_src/lat_cutout.png \\
        --sat-threshold 55
"""
from __future__ import annotations

import argparse
import pathlib

import cv2
import numpy as np


def segment(image_bgr: np.ndarray, sat_threshold: float, soft_band: float = 35.0) -> np.ndarray:
    hsv = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2HSV).astype(np.float64)
    saturation = hsv[..., 1]
    alpha = np.clip((saturation - sat_threshold) / soft_band, 0, 1)

    # Remove small speckles (stray saturated pixels in text/icons) then
    # soften edges so the warp doesn't inherit a jagged cutout boundary.
    alpha_u8 = (alpha * 255).astype(np.uint8)
    alpha_u8 = cv2.morphologyEx(alpha_u8, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    alpha_u8 = cv2.GaussianBlur(alpha_u8, (5, 5), 0)

    rgba = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2BGRA)
    rgba[..., 3] = alpha_u8
    return rgba


def crop_to_content(rgba: np.ndarray, pad: int = 12) -> np.ndarray:
    ys, xs = np.where(rgba[..., 3] > 10)
    if len(xs) == 0:
        return rgba
    x0, x1 = max(0, xs.min() - pad), min(rgba.shape[1], xs.max() + pad)
    y0, y1 = max(0, ys.min() - pad), min(rgba.shape[0], ys.max() + pad)
    return rgba[y0:y1, x0:x1]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--in", dest="in_path", required=True, type=pathlib.Path)
    parser.add_argument("--out", dest="out_path", required=True, type=pathlib.Path)
    parser.add_argument("--sat-threshold", type=float, default=55.0)
    args = parser.parse_args()

    image = cv2.imread(str(args.in_path))
    if image is None:
        raise SystemExit(f"Could not read {args.in_path}")
    rgba = segment(image, args.sat_threshold)
    rgba = crop_to_content(rgba)
    args.out_path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(args.out_path), rgba)
    print(f"Wrote {args.out_path} ({rgba.shape[1]}x{rgba.shape[0]})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
