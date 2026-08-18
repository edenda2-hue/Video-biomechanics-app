#!/usr/bin/env python3
"""Interactive tool for curating a muscle cutout's control points.

Given an isolated, transparent-background muscle cutout PNG (cropped by
hand from a Gray's Anatomy plate -- this script does not do the cropping),
click the same anatomical landmark points the muscle's anchor_landmarks
list expects (see muscle_library/catalog.json), in that exact order, and
this writes the sidecar JSON compositing/assets.py reads them from.

Usage:
    python3 scripts/pick_control_points.py --muscle-id latissimus_dorsi_r \\
        --image assets/anatomy/muscles/latissimus_dorsi_r.png

Click points in the order printed at startup (it's muscle.anchor_landmarks,
e.g. for latissimus_dorsi_r: RIGHT_SHOULDER, RIGHT_HIP, RIGHT_ELBOW -- click
where each of those would sit *on this cutout image* if it were on a body).
Press 'u' to undo the last point, 's' to save once all points are placed,
'q' to quit without saving.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys

import cv2

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from muscle_library.library import MuscleLibrary  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--muscle-id", required=True)
    parser.add_argument("--image", required=True, type=pathlib.Path)
    args = parser.parse_args()

    lib = MuscleLibrary.load()
    muscle = lib.get(args.muscle_id)
    print(f"Click, in order: {list(muscle.anchor_landmarks)}")
    print("Keys: u=undo  s=save  q=quit-without-saving")

    image = cv2.imread(str(args.image), cv2.IMREAD_UNCHANGED)
    if image is None:
        print(f"Could not read {args.image}", file=sys.stderr)
        return 1
    display_base = image[..., :3].copy() if image.ndim == 3 and image.shape[2] == 4 else image.copy()

    points: list[tuple[float, float]] = []

    def on_click(event, x, y, flags, userdata):
        if event == cv2.EVENT_LBUTTONDOWN and len(points) < len(muscle.anchor_landmarks):
            points.append((float(x), float(y)))

    window = f"pick_control_points: {muscle.id}"
    cv2.namedWindow(window)
    cv2.setMouseCallback(window, on_click)

    while True:
        frame = display_base.copy()
        for i, (x, y) in enumerate(points):
            cv2.circle(frame, (int(x), int(y)), 5, (0, 255, 0), -1)
            label = muscle.anchor_landmarks[i]
            cv2.putText(frame, label, (int(x) + 8, int(y)), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 255, 0), 1, cv2.LINE_AA)
        remaining = len(muscle.anchor_landmarks) - len(points)
        cv2.putText(frame, f"{remaining} point(s) left" if remaining else "all points placed - press 's' to save",
                    (10, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 1, cv2.LINE_AA)
        cv2.imshow(window, frame)
        key = cv2.waitKey(20) & 0xFF
        if key == ord("u") and points:
            points.pop()
        elif key == ord("q"):
            print("Quit without saving.")
            return 0
        elif key == ord("s"):
            if len(points) != len(muscle.anchor_landmarks):
                print(f"Need exactly {len(muscle.anchor_landmarks)} points, have {len(points)}")
                continue
            sidecar = args.image.parent / f"{muscle.id}.json"
            sidecar.write_text(json.dumps({"control_points": points}, indent=2), encoding="utf-8")
            print(f"Saved {sidecar}")
            return 0


if __name__ == "__main__":
    sys.exit(main())
