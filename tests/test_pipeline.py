#!/usr/bin/env python3
"""Dependency-free smoke tests for the general pipeline.

These validate that every module is correctly wired end-to-end using
synthetic data (manually constructed poses, a generated test video, a
generated placeholder-only muscle selection). They do NOT validate
biomechanical/anatomical correctness -- that requires the real test clip
(input/test_clip_1.mov, not yet uploaded) and professional sign-off on the
output, per the project brief.

Run: python3 tests/test_pipeline.py
"""
from __future__ import annotations

import math
import pathlib
import subprocess
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import numpy as np

from compositing.occlusion import resolve_opacity, GHOST_OPACITY, FULL_OPACITY
from compositing.overlay import build_muscle_overlay
from compositing.warp import warp_onto_canvas
from muscle_library.library import MuscleLibrary
from muscle_library.schema import BodyRegion, Laterality, MuscleDefinition, SurfaceFacing
from pose.angles import compute_joint_angles, estimate_torso_yaw_deg
from pose.detector import PoseDetectionError, detect_pose
from pose.types import Landmark, PoseFrame
from video.ffmpeg_utils import probe
from video.segments import build_annotated_video

FAILURES: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}" + (f" -- {detail}" if detail and not condition else ""))
    if not condition:
        FAILURES.append(name)


def synthetic_pose_frame(width: int = 640, height: int = 480, yaw_shoulder_z_delta: float = 0.0) -> PoseFrame:
    """A physically plausible standing pose, purely from coordinates --
    no image/model involved. Good enough to exercise angle math, warping,
    and occlusion without needing a real photo of a person."""

    def lm(x, y, z=0.0, vis=0.95):
        return Landmark(x=x / width, y=y / height, z=z, visibility=vis)

    landmarks = {
        "NOSE": lm(320, 60),
        "LEFT_SHOULDER": lm(260, 140, z=0.0),
        "RIGHT_SHOULDER": lm(380, 140, z=yaw_shoulder_z_delta),
        "LEFT_ELBOW": lm(230, 230),
        "RIGHT_ELBOW": lm(410, 230),
        "LEFT_WRIST": lm(220, 320),
        "RIGHT_WRIST": lm(420, 320),
        "LEFT_HIP": lm(275, 300),
        "RIGHT_HIP": lm(365, 300),
        "LEFT_KNEE": lm(270, 400),
        "RIGHT_KNEE": lm(370, 400),
        "LEFT_ANKLE": lm(265, 460),
        "RIGHT_ANKLE": lm(375, 460),
        "LEFT_FOOT_INDEX": lm(255, 470),
        "RIGHT_FOOT_INDEX": lm(385, 470),
        "LEFT_HEEL": lm(260, 465),
        "RIGHT_HEEL": lm(380, 465),
    }
    return PoseFrame(frame_width=width, frame_height=height, timestamp_s=1.0, landmarks=landmarks)


def test_joint_angles():
    frame = synthetic_pose_frame()
    angles = compute_joint_angles(frame)
    check("joint angles computed for all limbs with full landmark coverage",
          set(angles) >= {"left_knee", "right_knee", "left_elbow", "right_elbow", "left_hip", "right_hip"},
          detail=str(sorted(angles)))
    for name, deg in angles.items():
        check(f"angle '{name}' is a sane 0-180 value ({deg:.1f})", 0.0 <= deg <= 180.0)


def test_torso_yaw():
    frontal = synthetic_pose_frame(yaw_shoulder_z_delta=0.0)
    check("yaw ~0 when shoulders are equidistant from camera",
          abs(estimate_torso_yaw_deg(frontal)) < 1.0, detail=str(estimate_torso_yaw_deg(frontal)))

    rotated = synthetic_pose_frame(yaw_shoulder_z_delta=-0.3)
    yaw = estimate_torso_yaw_deg(rotated)
    check("yaw is nonzero and signed sensibly when one shoulder is closer to camera",
          abs(yaw) > 5.0, detail=str(yaw))


def _dummy_muscle(surface_facing: SurfaceFacing, laterality: Laterality = Laterality.CENTRAL) -> MuscleDefinition:
    return MuscleDefinition(
        id="dummy", name="Dummy", name_he="דמה", group=BodyRegion.CORE, laterality=laterality,
        anchor_landmarks=("LEFT_SHOULDER", "LEFT_HIP"), surface_facing=surface_facing,
        cutout_asset="__does_not_exist__.png", source_plate_hint="n/a",
    )


def test_occlusion():
    anterior = _dummy_muscle(SurfaceFacing.ANTERIOR)
    posterior = _dummy_muscle(SurfaceFacing.POSTERIOR)

    check("anterior muscle near-full opacity when body faces camera (yaw=0)",
          resolve_opacity(anterior, 0.0) > 0.8 * FULL_OPACITY)
    check("posterior muscle near-ghost opacity when body faces camera (yaw=0)",
          resolve_opacity(posterior, 0.0) < GHOST_OPACITY + 0.05)
    check("anterior and posterior opacity swap roles at yaw=180",
          resolve_opacity(anterior, 180.0) < resolve_opacity(posterior, 180.0))
    for m in (anterior, posterior):
        for yaw in (-180, -90, 0, 90, 180):
            o = resolve_opacity(m, yaw)
            check(f"opacity within bounds at yaw={yaw}", GHOST_OPACITY - 1e-6 <= o <= FULL_OPACITY + 1e-6)


def test_warp_basic():
    src = np.zeros((100, 100, 4), dtype=np.uint8)
    src[20:80, 20:80] = (0, 0, 255, 255)  # opaque red square, BGR
    source_points = [(50.0, 20.0), (50.0, 80.0), (20.0, 50.0)]  # top, bottom, left of the square
    target_points = [(300.0, 100.0), (300.0, 300.0), (200.0, 200.0)]

    result = warp_onto_canvas(src, source_points, target_points, canvas_size=(640, 480))
    check("warp output has correct canvas size", result.shape == (480, 640, 4))
    cx, cy = 300, 200
    check("warped content is opaque near the target centroid",
          result[cy, cx, 3] > 100, detail=f"alpha={result[cy, cx, 3]}")
    check("warped content is transparent far from any target point",
          result[10, 10, 3] == 0)


def test_warp_collinear_points_dont_shred():
    """Regression test: a fully-extended-limb pose (e.g. a front lever,
    arm straight overhead) puts a 3-point muscle's shoulder/elbow/wrist
    control points almost exactly on one line. TPS is defined for that but
    extrapolates unboundedly for source content off the line, which was
    observed to shred a wide muscle cutout into repeated stretched strips.
    warp_onto_canvas should detect this and fall back to a rigid
    similarity transform instead, keeping the source content intact."""
    src = np.zeros((100, 200, 4), dtype=np.uint8)
    src[20:80, 20:180] = (0, 0, 255, 255)  # wide opaque red band, BGR
    # source control points collinear along the horizontal midline
    source_points = [(30.0, 50.0), (100.0, 50.0), (170.0, 50.0)]
    # target points also collinear, but much longer (simulating a fully
    # extended limb far larger on-screen than the source drawing)
    target_points = [(100.0, 100.0), (100.0, 300.0), (100.0, 500.0)]

    result = warp_onto_canvas(src, source_points, target_points, canvas_size=(400, 640))
    opaque_fraction = (result[..., 3] > 100).sum() / result[..., 3].size
    # A shredded/exploded warp leaves either almost nothing (content
    # scattered to invisibly-thin slivers) or implausibly much (runaway
    # extrapolation) opaque; a sane rigid transform of a solid band keeps
    # a moderate, bounded fraction of the canvas opaque.
    check("collinear control points don't shred the source into slivers/blowup",
          0.02 < opaque_fraction < 0.5, detail=f"opaque_fraction={opaque_fraction:.4f}")


def test_muscle_library():
    lib = MuscleLibrary.load()
    all_muscles = lib.all()
    check("catalog has full-body coverage (>= 20 muscles)", len(all_muscles) >= 20, detail=str(len(all_muscles)))
    groups = {m.group for m in all_muscles}
    check("catalog spans upper_body, core, and lower_body",
          groups == {BodyRegion.UPPER_BODY, BodyRegion.CORE, BodyRegion.LOWER_BODY}, detail=str(groups))

    milestone1_case = lib.resolve([
        "latissimus_dorsi_r", "latissimus_dorsi_l", "triceps_brachii_r", "triceps_brachii_l",
        "rectus_abdominis", "gluteus_maximus_r", "gluteus_maximus_l",
    ])
    check("Milestone 1 test-case muscles all resolve", len(milestone1_case) == 7)

    leg_case = lib.resolve(["lower_body"])
    check("lower_body group resolves to leg muscles for the second (squat) validation pass",
          len(leg_case) >= 8, detail=str(len(leg_case)))

    try:
        lib.resolve(["not_a_real_muscle"])
        check("unknown muscle id raises", False)
    except KeyError:
        check("unknown muscle id raises", True)


def test_overlay_build_with_placeholders():
    frame = synthetic_pose_frame()
    lib = MuscleLibrary.load()
    muscles = lib.resolve(["latissimus_dorsi_r", "rectus_abdominis", "gluteus_maximus_r"])
    overlay = build_muscle_overlay(frame, muscles)
    check("overlay canvas matches frame size", overlay.shape == (480, 640, 4))
    check("overlay has some non-transparent content", bool((overlay[..., 3] > 0).any()))


def test_pose_model_loads_and_runs():
    """Confirms the real MediaPipe model (downloaded weights, not just the
    package) loads and runs inference. Uses a blank synthetic frame, so it
    correctly detects *no person* -- this is the one thing we can validate
    about pose detection without the real uploaded test clip."""
    model_path = pathlib.Path(__file__).resolve().parent.parent / "models" / "pose_landmarker_heavy.task"
    if not model_path.exists():
        check("pose model file present (run scripts/download_pose_model.py)", False)
        return
    blank = np.full((480, 640, 3), 200, dtype=np.uint8)
    try:
        detect_pose(blank, timestamp_s=0.0, model_path=model_path)
        check("pose model correctly finds no person in a blank frame", False)
    except PoseDetectionError as e:
        check("pose model loads real weights and runs inference (correctly finds no person)",
              "No person detected" in str(e), detail=str(e))


def test_video_segment_pipeline():
    """End-to-end mechanical validation of the ffmpeg 3-segment build using
    a synthetically generated test video (ffmpeg testsrc), since the real
    gym-exercise clip (input/test_clip_1.mov) hasn't been uploaded yet.
    Proves segment extraction, freeze+fade-in rendering, and concat all
    work for an arbitrary duration/resolution/fps -- the video pipeline
    never looks at what's actually in the frames."""
    with tempfile.TemporaryDirectory(prefix="biomech_smoketest_") as tmp:
        tmp_path = pathlib.Path(tmp)
        synth_video = tmp_path / "synthetic.mp4"
        subprocess.run([
            "ffmpeg", "-y", "-f", "lavfi", "-i", "testsrc=duration=4:size=640x480:rate=25",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(synth_video),
        ], capture_output=True)
        check("synthetic test video generated", synth_video.exists())
        if not synth_video.exists():
            return

        info = probe(synth_video)
        check("synthetic video probed with expected properties",
              info.width == 640 and info.height == 480 and info.has_audio,
              detail=str(info))

        frame = synthetic_pose_frame(width=640, height=480)
        lib = MuscleLibrary.load()
        muscles = lib.resolve(["latissimus_dorsi_r", "triceps_brachii_r", "gluteus_maximus_r"])
        overlay = build_muscle_overlay(frame, muscles)
        frozen_frame_bgr = np.full((480, 640, 3), 128, dtype=np.uint8)

        output_path = tmp_path / "annotated.mp4"
        build_annotated_video(
            video_path=synth_video, pause_time_s=1.0, freeze_duration_s=2.0,
            frozen_frame_bgr=frozen_frame_bgr, overlay_rgba=overlay,
            output_path=output_path, fade_in_s=0.4,
        )
        check("annotated output video created", output_path.exists())
        if not output_path.exists():
            return

        out_info = probe(output_path)
        expected_duration = 4.0 + 2.0  # original 4s + freeze_duration inserted at t=1s
        check("output duration ~= original + freeze_duration",
              math.isclose(out_info.duration_s, expected_duration, abs_tol=0.5),
              detail=f"got {out_info.duration_s:.2f}s, expected ~{expected_duration:.2f}s")
        check("output resolution matches source", (out_info.width, out_info.height) == (640, 480))


def main() -> int:
    for fn in [
        test_joint_angles, test_torso_yaw, test_occlusion, test_warp_basic,
        test_warp_collinear_points_dont_shred,
        test_muscle_library, test_overlay_build_with_placeholders,
        test_pose_model_loads_and_runs, test_video_segment_pipeline,
    ]:
        print(f"\n== {fn.__name__} ==")
        fn()

    print(f"\n{'='*60}")
    if FAILURES:
        print(f"{len(FAILURES)} check(s) FAILED: {FAILURES}")
        return 1
    print("All checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
