"""Typed schema for the muscle library.

The library is data (muscle_library/catalog.json), not code — adding a new
muscle or covering a new body region never requires touching the pipeline
logic in pose/, compositing/, or video/. That's the mechanism that keeps the
architecture from silently specializing to the one exercise used for
Milestone 1's test case.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class Laterality(str, Enum):
    LEFT = "left"
    RIGHT = "right"
    BILATERAL = "bilateral"  # rendered once per side using mirrored anchors
    CENTRAL = "central"  # midline muscle, no left/right pair


class BodyRegion(str, Enum):
    UPPER_BODY = "upper_body"
    CORE = "core"
    LOWER_BODY = "lower_body"


class SurfaceFacing(str, Enum):
    """Which way the muscle's visible belly faces on a body standing
    upright and facing the camera. Used by compositing/occlusion.py to
    decide opacity for the current camera angle — see that module for how
    this maps to a continuous facing score instead of a hardcoded rule per
    muscle."""

    ANTERIOR = "anterior"
    POSTERIOR = "posterior"
    LATERAL = "lateral"


@dataclass(frozen=True)
class MuscleDefinition:
    id: str
    name: str
    name_he: str
    group: BodyRegion
    laterality: Laterality
    # MediaPipe Pose landmark names (see pose/types.py: LANDMARK_NAMES)
    # bounding the region this muscle occupies on the body. Used to derive
    # the target control points the muscle cutout gets warped onto.
    anchor_landmarks: tuple[str, ...]
    surface_facing: SurfaceFacing
    # Filename inside assets/anatomy/muscles/ (transparent PNG cutout).
    # May not exist yet — compositing/assets.py falls back to a clearly
    # labeled placeholder shape when it's missing, and logs a warning.
    cutout_asset: str
    # Human-readable pointer to the source plate this cutout should be
    # curated from, for whoever populates assets/anatomy/.
    source_plate_hint: str
    validated_by_professional: bool = False

    @staticmethod
    def from_dict(d: dict) -> "MuscleDefinition":
        return MuscleDefinition(
            id=d["id"],
            name=d["name"],
            name_he=d["name_he"],
            group=BodyRegion(d["group"]),
            laterality=Laterality(d["laterality"]),
            anchor_landmarks=tuple(d["anchor_landmarks"]),
            surface_facing=SurfaceFacing(d["surface_facing"]),
            cutout_asset=d["cutout_asset"],
            source_plate_hint=d["source_plate_hint"],
            validated_by_professional=d.get("validated_by_professional", False),
        )
