# Anatomy asset pipeline

This directory is data, not code — populating it doesn't touch anything
in `pose/`, `compositing/`, or `video/`. Two subfolders:

- `source/` — full Gray's Anatomy (1918, Public Domain) plates, as
  downloaded.
- `muscles/` — one transparent-background PNG cutout per muscle, cropped
  from a `source/` plate, plus a `<muscle_id>.json` sidecar of pixel-space
  control points. This is what `compositing/assets.py` actually loads.

## Current status

All 7 muscle instances in the Milestone 1 test case now have curated art
— every other catalog entry (17 more) still renders as the placeholder.
Two AI-generated reference sheets, both provided directly by the project
owner and confirmed as their own AI output (not scraped or commercial
art), not Gray's 1918:

- **Sheet 1** (standing, isolated close-ups per muscle, blank background):
  `latissimus_dorsi_{r,l}`, `triceps_brachii_{r,l}`, `gluteus_maximus_{r,l}`.
  Segmented with `scripts/segment_muscle_from_reference.py` (saturation
  threshold cleanly isolates each muscle since the source has blank space
  around it). Bilateral pairs the sheet only drew once were produced as a
  horizontal mirror of the other side (`cv2.flip`) rather than a second
  independent crop.
- **Sheet 2** (a single full-body illustration in the *same pose* as the
  test clip -- front lever / bar hold, arm fully extended overhead):
  `rectus_abdominis`. This sheet is continuous full-body art with no gaps
  between muscle groups, so saturation thresholding can't find a clean
  per-muscle boundary the way it does on sheet 1 -- the abs cutout is a
  plain rectangular crop of the visible abdominal region, lower detail
  than the sheet-1 cutouts, and its anchor_landmarks were simplified from
  4 points (`LEFT/RIGHT_SHOULDER`, `LEFT/RIGHT_HIP`) to 2
  (`RIGHT_SHOULDER`, `RIGHT_HIP`) since the source is a side view, not a
  symmetric front view a 4-point fit assumes. Sheet 2 was *not* used to
  redo the other 3 muscles -- sheet 1's isolated-close-up versions were
  already working well (see main README's warp-collinearity fix, verified
  against this exact clip), so they were kept rather than swapped for a
  same-pose source that's harder to cleanly segment.

**Control points for all 7 were placed by visual estimate on a pixel grid
overlay, not clicked interactively** (`pick_control_points.py` exists for
that but wasn't used this round) -- treat their placement as a rough first
pass pending the professional-review step below, not a verified fit.

- **Sheet 3** (`--style full-body` only, a third AI-generated sheet, also
  provided directly and confirmed as the owner's own AI output): a
  full-body illustration in the athlete's near-exact pose, used whole
  (not per-muscle) by `compositing/full_body.py` to replace the subject
  entirely rather than patch individual muscles onto them. Segmented by
  keying out near-white/near-black/low-saturation pixels (background +
  the pull-up rig, both effectively achromatic) with a border-flood-fill
  pass to avoid also punching holes at small internal dark
  shadows/creases in the illustration itself. Split into 3 files —
  `_fullbody_torso.png`, `_fullbody_left_arm.png`, `_fullbody_right_arm.png`
  — because a single whole-body thin-plate-spline fit folded the source
  image where the overhead-reaching arm sharply reverses direction
  relative to the flat torso (see main README "Key technical decisions").
  `_fullbody_figure.json` holds each layer's filename + landmark
  correspondences; unlike the per-muscle catalog entries, there's no
  `pick_control_points.py`-equivalent tool for this format yet — layer
  boundaries and points were picked by eye on a pixel grid.

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
