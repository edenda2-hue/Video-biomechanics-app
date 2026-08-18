"""Full-body illustration replacement mode.

Instead of overlaying individual muscle cutouts onto the real footage
(compositing/overlay.py), this mode erases the subject from the frozen
frame entirely and replaces them with a whole-figure anatomical
illustration warped to match their exact detected pose, composited into
the real (person-removed) background -- "the anatomy figure standing
where the athlete was," not patches on top of them.

Generic over any full-body reference asset with landmark correspondences.
It works best when the source illustration's pose is already close to the
subject's (as for the Milestone 1 test case's front-lever-matched
reference) -- the warp only has to make small corrections rather than a
large one, which keeps the result looking clean rather than rubbery. A
source in a very different pose from the target would still numerically
warp, just with more visible distortion; nothing here assumes a
particular pose, camera angle, or exercise.
"""
from __future__ import annotations

import json
import logging
import pathlib

import cv2
import numpy as np

from compositing.warp import warp_onto_canvas
from pose.types import PoseFrame

logger = logging.getLogger(__name__)

ASSETS_DIR = pathlib.Path(__file__).resolve().parent.parent / "assets" / "anatomy" / "muscles"
DEFAULT_FIGURE_LANDMARKS_PATH = ASSETS_DIR / "_fullbody_figure.json"


class FullBodyLayer:
    def __init__(self, image_rgba: np.ndarray, landmarks_px: dict[str, tuple[float, float]]):
        self.image_rgba = image_rgba
        self.landmarks_px = landmarks_px


class FullBodyAsset:
    """One or more independently-warped layers cut from the same
    illustration. A single layer with many spread-out landmarks (e.g. head
    to feet) works fine for TPS as long as the body doesn't sharply change
    direction between them. A limb that bends back on itself relative to
    the torso -- e.g. an arm reaching up while the torso lies flat, as in
    a front lever/pull-up -- does exactly that, and was observed to make a
    single whole-body TPS fit fold the source image into a self-
    intersecting mess. Splitting such limbs into their own layer (each
    warped independently, typically with just its own 2 endpoints via a
    rigid similarity transform) avoids that failure mode; multiple layers
    are simply alpha-composited back together in listed order."""

    def __init__(self, layers: list[FullBodyLayer]):
        self.layers = layers


def load_fullbody_asset(
    landmarks_path: pathlib.Path = DEFAULT_FIGURE_LANDMARKS_PATH,
    assets_dir: pathlib.Path = ASSETS_DIR,
) -> FullBodyAsset:
    data = json.loads(pathlib.Path(landmarks_path).read_text(encoding="utf-8"))
    layers = []
    for layer_spec in data["layers"]:
        image_path = assets_dir / layer_spec["image"]
        image = cv2.imread(str(image_path), cv2.IMREAD_UNCHANGED)
        if image is None or image.shape[2] != 4:
            raise FileNotFoundError(f"Full-body layer not found or missing alpha channel: {image_path}")
        landmarks_px = {name: tuple(pt) for name, pt in layer_spec["landmarks"].items()}
        layers.append(FullBodyLayer(image, landmarks_px))
    return FullBodyAsset(layers)


def warp_fullbody_onto_pose(asset: FullBodyAsset, pose_frame: PoseFrame, min_visibility: float = 0.3) -> np.ndarray:
    """Warp each layer of the illustration so its own landmarks land on
    the detected pose's corresponding landmarks, and composite the
    warped layers together. Returns an RGBA canvas the size of the video
    frame. Uses whichever named landmarks each layer and the detected pose
    have in common and confident about -- so a partially occluded pose or
    a layer with fewer annotated points still works, just with a coarser
    fit."""
    canvas_size = (pose_frame.frame_width, pose_frame.frame_height)
    result = np.zeros((pose_frame.frame_height, pose_frame.frame_width, 4), dtype=np.uint8)

    for layer in asset.layers:
        shared = [
            name for name in layer.landmarks_px
            if name in pose_frame.landmarks and pose_frame.landmarks[name].visibility >= min_visibility
        ]
        if len(shared) < 2:
            logger.warning("Skipping a full-body layer: not enough shared, visible landmarks (found %d)", len(shared))
            continue
        source_points = [layer.landmarks_px[name] for name in shared]
        target_points = [pose_frame.px(name) for name in shared]
        warped = warp_onto_canvas(layer.image_rgba, source_points, target_points, canvas_size, margin_px=100.0)

        base_a = result[..., 3:4].astype(np.float64) / 255.0
        layer_a = warped[..., 3:4].astype(np.float64) / 255.0
        out_a = layer_a + base_a * (1 - layer_a)
        with np.errstate(invalid="ignore", divide="ignore"):
            out_rgb = (
                warped[..., :3].astype(np.float64) * layer_a
                + result[..., :3].astype(np.float64) * base_a * (1 - layer_a)
            ) / np.clip(out_a, 1e-6, None)
        result[..., :3] = np.clip(out_rgb, 0, 255).astype(np.uint8)
        result[..., 3] = np.clip(out_a[..., 0] * 255, 0, 255).astype(np.uint8)

    return result


def inpaint_person_out(frame_bgr: np.ndarray, segmentation_mask: np.ndarray, dilate_px: int = 15) -> np.ndarray:
    """Erase the person from `frame_bgr` and fill the hole with a
    plausible background via single-frame inpainting.

    This is inherently approximate: inpainting can only extrapolate from
    the surrounding pixels of this one frame, so complex structure that's
    actually occluded by the body (e.g. a straight bar passing behind the
    torso) won't be reconstructed exactly -- it'll get smoothed over. Good
    enough for a background that's mostly open sky/foliage/simple
    equipment lines, not a guarantee for arbitrary backgrounds.
    """
    mask_u8 = (segmentation_mask > 0.5).astype(np.uint8) * 255
    if mask_u8.ndim == 3:
        mask_u8 = mask_u8[..., 0]
    mask_u8 = cv2.dilate(mask_u8, np.ones((dilate_px, dilate_px), np.uint8))

    # cv2.inpaint gets slow and its quality doesn't meaningfully improve
    # at full 4K, so work at a capped resolution and upscale back --
    # consistent with this project's general approach of trading a bit of
    # precision for finishing in reasonable time on full-res phone video.
    longest_side = max(frame_bgr.shape[:2])
    scale = min(1.0, 1024 / longest_side)
    if scale < 1.0:
        small_frame = cv2.resize(frame_bgr, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
        small_mask = cv2.resize(mask_u8, None, fx=scale, fy=scale, interpolation=cv2.INTER_NEAREST)
        small_result = cv2.inpaint(small_frame, small_mask, 5, cv2.INPAINT_TELEA)
        result = cv2.resize(small_result, (frame_bgr.shape[1], frame_bgr.shape[0]), interpolation=cv2.INTER_LINEAR)
    else:
        result = cv2.inpaint(frame_bgr, mask_u8, 5, cv2.INPAINT_TELEA)
    return result


def build_fullbody_composite(
    frame_bgr: np.ndarray,
    pose_frame: PoseFrame,
    asset: FullBodyAsset | None = None,
) -> np.ndarray:
    """Erase+inpaint the real person, warp the illustration onto their
    exact detected pose, and composite it into the cleaned background.
    Returns a BGR frame the same size as frame_bgr -- the "target" frame
    the freeze segment fades into."""
    asset = asset or load_fullbody_asset()
    if pose_frame.segmentation_mask is None:
        raise ValueError(
            "build_fullbody_composite requires a PoseFrame with segmentation_mask populated "
            "(pass with_segmentation_mask=True to detect_pose/detect_pose_at_time)"
        )

    background_bgr = inpaint_person_out(frame_bgr, pose_frame.segmentation_mask)
    warped_illustration = warp_fullbody_onto_pose(asset, pose_frame)

    alpha = warped_illustration[..., 3:4].astype(np.float64) / 255.0
    composited = (
        background_bgr.astype(np.float64) * (1 - alpha)
        + warped_illustration[..., :3].astype(np.float64) * alpha
    )
    return composited.astype(np.uint8)
