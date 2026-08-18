# Anatomy asset pipeline

This directory is data, not code — populating it doesn't touch anything
in `pose/`, `compositing/`, or `video/`. Two subfolders:

- `source/` — full Gray's Anatomy (1918, Public Domain) plates, as
  downloaded.
- `muscles/` — one transparent-background PNG cutout per muscle, cropped
  from a `source/` plate, plus a `<muscle_id>.json` sidecar of pixel-space
  control points. This is what `compositing/assets.py` actually loads.

## Current status

6 of 24 catalog entries have curated art: `latissimus_dorsi_{r,l}`,
`triceps_brachii_{r,l}`, `gluteus_maximus_{r,l}`. Source: an AI-generated
reference illustration sheet the project owner provided directly (not
Gray's 1918 -- confirmed with them that they generated it themselves, so
it's clear to use here; see git history for the exact exchange). It was
segmented into per-muscle transparent cutouts with
`scripts/segment_muscle_from_reference.py` (keys on saturation: this
illustration style draws muscle tissue as saturated red/salmon against
white background, pale bone, and dark text/labels, so thresholding
saturation cleanly isolates the muscle from everything else in one pass).
Bilateral pairs that the reference only drew once were produced as a
horizontal mirror of the other side (`cv2.flip`) rather than a second
independent crop -- anatomically valid for paired muscles, and it
guarantees the two sides are exactly symmetric.

`rectus_abdominis` (and everything else in the catalog) still has no
curated art and renders as the placeholder described below -- the
reference sheet didn't include it, and Gray's 1918 is still unreachable
from this sandbox (see next section).

**Control points for the 6 curated muscles were placed by visual estimate
on a pixel grid overlay, not clicked interactively** (`pick_control_points.py`
exists for that but wasn't used this round) -- treat their placement as a
rough first pass pending the professional-review step below, not a
verified fit.

## Why Gray's 1918 isn't populated

This project's sandbox blocks the only legitimate source for these
images. Confirmed during Milestone 1 development (all returned 403 at the
network proxy, i.e. blocked by org egress policy, not down):

- `commons.wikimedia.org`, `upload.wikimedia.org`, `en.wikipedia.org` — Gray's
  Anatomy 1918 Public Domain plates
- `archive.org` — alternate Public Domain hosting of the same book
- `huggingface.co` — checked as a fallback dataset mirror; also blocked

Reachable from this sandbox: `github.com`/`raw.githubusercontent.com`,
`pypi.org`, `storage.googleapis.com` (that's how `models/*.task` got
downloaded for real). None of them host Gray's 1918 plates.

**Until Wikimedia access is allowlisted for this project, or someone runs
the fetch step from an unrestricted machine, this step is blocked** — it
is not something to route around with a lower-quality substitute. The
project brief already tried vector-drawn muscle shapes in an earlier
prototype and rejected them as not organic-looking; a placeholder here
exists only to keep the *pipeline* testable, never as a stand-in for real
curation (see below).

## What runs for everything else

`compositing/assets.py` generates a clearly-labeled procedural placeholder
(a soft, fiber-streaked, watermarked blob) for any muscle without a
curated cutout, and logs a warning every time it does. This lets every
other stage — pose detection, warping, occlusion, video assembly — be
built and tested now, without waiting on the asset pipeline. It is not
final visual quality and isn't meant to be.

## Curation workflow, once the plates are reachable

1. `python3 scripts/fetch_anatomy_plates.py --list` for the Commons
   category browse URL; pick plates covering the muscle you need, then
   `python3 scripts/fetch_anatomy_plates.py --plate "Gray123.png"` to pull
   them into `source/` (each download gets a `.source_url.txt` sidecar
   recording provenance, for the professional-validation step).
2. Crop the single muscle out of the plate into its own transparent PNG
   at `muscles/<cutout_asset>` (per `muscle_library/catalog.json`'s
   `cutout_asset` field) — any image editor that supports alpha, e.g. GIMP.
   Keep the crop generous enough that the muscle's full length is visible;
   the warp step needs real extent to bend correctly.
3. `python3 scripts/pick_control_points.py --muscle-id <id> --image
   muscles/<cutout_asset>` — click the muscle's `anchor_landmarks` (in
   order) on the cutout image. Writes `muscles/<id>.json`.
4. Run `python3 tests/test_pipeline.py` — the placeholder warning for that
   muscle id should disappear.
5. Get the result reviewed by the professional who approved the
   Milestone 1 test case's muscle placement (see main README's validation
   checklist) before treating it as correct.

## Muscle → source plate mapping

`muscle_library/catalog.json`'s `source_plate_hint` field names which
region of Gray's 1918 each muscle should be cut from (e.g. "muscles of the
back, superficial layer"). It's a description, not a verified Commons
filename — nobody on this project has been able to browse Commons yet to
confirm exact plate numbers.
