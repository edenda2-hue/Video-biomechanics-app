"""Loader / query API for the muscle catalog.

    from muscle_library.library import MuscleLibrary
    lib = MuscleLibrary.load()
    selected = lib.resolve(["latissimus_dorsi_r", "triceps_brachii_r"])

`resolve` accepts muscle ids, and also group names ("lower_body") or "all"
as a convenience for exercises that need a whole region highlighted.
"""
from __future__ import annotations

import json
import pathlib
from typing import Iterable

from muscle_library.schema import BodyRegion, MuscleDefinition

DEFAULT_CATALOG_PATH = pathlib.Path(__file__).resolve().parent / "catalog.json"


class MuscleLibrary:
    def __init__(self, muscles: list[MuscleDefinition]):
        self._by_id = {m.id: m for m in muscles}

    @classmethod
    def load(cls, path: pathlib.Path | None = None) -> "MuscleLibrary":
        path = path or DEFAULT_CATALOG_PATH
        data = json.loads(path.read_text(encoding="utf-8"))
        muscles = [MuscleDefinition.from_dict(m) for m in data["muscles"]]
        return cls(muscles)

    def all(self) -> list[MuscleDefinition]:
        return list(self._by_id.values())

    def get(self, muscle_id: str) -> MuscleDefinition:
        try:
            return self._by_id[muscle_id]
        except KeyError:
            known = ", ".join(sorted(self._by_id))
            raise KeyError(f"Unknown muscle id '{muscle_id}'. Known ids: {known}") from None

    def by_group(self, group: BodyRegion | str) -> list[MuscleDefinition]:
        group = BodyRegion(group)
        return [m for m in self._by_id.values() if m.group == group]

    def resolve(self, selectors: Iterable[str]) -> list[MuscleDefinition]:
        """Turn a list of muscle ids and/or group names ("upper_body",
        "core", "lower_body", "all") into a de-duplicated list of
        MuscleDefinition, preserving first-seen order."""
        result: dict[str, MuscleDefinition] = {}
        for sel in selectors:
            if sel == "all":
                for m in self._by_id.values():
                    result.setdefault(m.id, m)
            elif sel in (r.value for r in BodyRegion):
                for m in self.by_group(sel):
                    result.setdefault(m.id, m)
            else:
                m = self.get(sel)
                result.setdefault(m.id, m)
        return list(result.values())
