# Video Biomechanics App

Interactive video anatomy overlay: upload any exercise/movement video, pick
a moment to pause on and a set of muscles to highlight, and the pipeline
freezes the video there, fades in an anatomically-placed muscle overlay
fitted to the detected pose at that exact frame, holds it, then resumes
playback. General-purpose by design — not built around any one exercise.

**תקציר (עברית):** זהו ה-pipeline הכללי של Milestone 1 — לא פתרון חד-פעמי.
הוא בנוי ונבדק (ראו "What's validated" למטה), אך שני דברים חסרים כדי
להריץ אותו על מקרה הבדיקה האמיתי: (1) קובץ הווידאו עדיין לא הועלה
ל-`input/`, ו-(2) מדיניות הרשת של הסביבה הזו חוסמת את Wikimedia Commons,
כך שתמונות Gray's Anatomy האמיתיות עדיין לא ירדו — במקומן יש placeholder
מסומן בבירור. פרטים מלאים בהמשך המסמך (באנגלית) ובקובץ
`assets/anatomy/README.md`.

## Status: Milestone 1

The general pipeline is built and mechanically validated end-to-end
(synthetic data + real photos, see "What's validated" below). It has
**not** been run against the actual test clip described in the project
brief (static bar-hold exercise, pause at t=1s, 3s freeze, Latissimus
Dorsi / Triceps Brachii / Rectus Abdominis / Gluteus Maximus), because
that video hasn't been uploaded to `input/` yet, and it has **not** been
run with real anatomical art, because this sandbox's network policy blocks
Wikimedia Commons (see "Network constraints"). Both are blocking, external
inputs — not open pipeline work.

## Architecture

```
input/<video>  →  pose/detector.py  →  PoseFrame (33 landmarks + angles)
                        │
muscle_library/         │
  catalog.json  ───►  muscle_library/library.py  →  MuscleDefinition list
  (full-body,           │
   data-driven)         ▼
              compositing/assets.py   (cutout PNG + control points, or
                        │              a clearly-labeled placeholder)
                        ▼
              compositing/warp.py     (thin-plate-spline / similarity
                        │              warp onto pose-derived target points)
                        ▼
              compositing/occlusion.py (camera-facing-based opacity)
                        ▼
              compositing/overlay.py  (alpha-composite all muscles → 1 RGBA layer)
                        │
                        ▼
              video/segments.py + ffmpeg  (segment 1: original up to pause
                                            segment 2: frozen frame, overlay fades in, holds
                                            segment 3: original from pause to end
                                            → concat)
                        │
                        ▼
                    output video
```

Everything above is parameterized: video path, pause timestamp, freeze
duration, fade-in duration, and muscle selection are all CLI arguments
(`cli.py`) — none of them appear as constants in the pipeline modules.
Adding a muscle means adding a `muscle_library/catalog.json` entry, not
writing code.

### Modules

| Module | Responsibility |
|---|---|
| `pose/types.py` | Shared landmark/pose dataclasses + MediaPipe's 33 landmark names + joint-angle definitions. No MediaPipe import — keeps the rest of the codebase decoupled from the pose backend. |
| `pose/detector.py` | Extracts a frame at an arbitrary timestamp (OpenCV) and runs MediaPipe Pose Landmarker (Tasks API, real downloaded weights) on it. |
| `pose/angles.py` | Generic joint-angle math (law-of-cosines at each joint) and a torso-yaw estimate from shoulder depth (z) asymmetry, used by occlusion. |
| `muscle_library/schema.py` | Typed `MuscleDefinition` — id, laterality, which pose landmarks anchor its placement, which side of the body it faces, asset filename, source-plate hint, and a `validated_by_professional` flag. |
| `muscle_library/catalog.json` | The actual full-body catalog (24 entries: upper body, core, lower body — see below). Data, not code. |
| `muscle_library/library.py` | Loads the catalog; `resolve()` turns a list of muscle ids and/or group names (`upper_body`/`core`/`lower_body`/`all`) into `MuscleDefinition`s. |
| `compositing/assets.py` | Loads a muscle's cutout image + control points, or synthesizes a labeled placeholder if the curated asset doesn't exist yet. |
| `compositing/warp.py` | Warps a source image so its control points land on target (pose-derived) points — thin-plate spline for ≥3 points, similarity transform for exactly 2. |
| `compositing/occlusion.py` | Continuous opacity from the angle between the camera's viewing axis and each muscle's estimated body-surface normal (derived from torso yaw + the muscle's declared facing) — not a per-exercise rule. |
| `compositing/overlay.py` | Combines warped, opacity-adjusted muscles into one RGBA layer per pose frame, and alpha-composites that layer onto a video frame at a given fade level. |
| `video/ffmpeg_utils.py` | `ffprobe`/`ffmpeg` subprocess wrappers — resolution/fps/duration/audio-presence detection. |
| `video/segments.py` | Builds and concatenates the 3 segments for any duration/resolution/fps/codec input. |
| `cli.py` | Orchestrates all of the above from command-line arguments. |
| `tests/test_pipeline.py` | Dependency-free smoke tests (see below). |

## Key technical decisions

- **Gray's Anatomy (1918), not Netter.** Netter Atlas is commercially
  licensed; Gray's 1918 (20th edition) is unambiguously Public Domain.
  `assets/anatomy/README.md` documents the intended sourcing/curation
  workflow via Wikimedia Commons.
- **Image-based muscle art, not vector shapes.** The earlier chat-only
  prototype tried vector-drawn muscle fibers and it wasn't organic-looking
  — this rejects that approach again for Milestone 1's placeholders (they
  exist only to test pipeline wiring, and are logged/labeled as such
  everywhere they appear) and commits the real asset path to curated
  raster cutouts warped onto the pose.
- **Thin-plate spline warp**, not a rigid affine transform, so a muscle
  cutout can bend to follow a bent limb instead of just scaling/rotating —
  implemented with `scipy.interpolate.RBFInterpolator` rather than
  `opencv-contrib`'s TPS transformer, so the project only depends on
  plain `opencv-python`.
- **Occlusion via a continuous facing score**, not a hardcoded
  front/back rule per exercise: each muscle declares which way it faces on
  an upright body (`surface_facing` + `laterality`), and that's rotated by
  a per-frame torso-yaw estimate (derived from MediaPipe's relative
  landmark depth) and compared to the camera's fixed viewing axis via
  cosine similarity. This is the generic mechanism the brief asked for —
  it works for any camera angle without per-exercise tuning, though it's a
  coarse 2-shoulder proxy for true 3D orientation (see "Known
  limitations").
- **Pose model: `pose_landmarker_heavy`**, MediaPipe's most accurate
  variant. Chosen because the pipeline only runs inference on the single
  paused frame per request, not every frame of the video, so the extra
  latency of "heavy" vs "lite" is irrelevant and the accuracy is worth it.
- **ffmpeg concat via re-encoding all 3 segments to one common
  codec/resolution/fps/pixel-format** (taken from the source video via
  `ffprobe`) rather than stream-copying, so concatenation works regardless
  of the input file's original codec.

## Network constraints hit in this sandbox

Confirmed via direct `curl` probes and the proxy's own status endpoint
during development — the org's egress policy denies these with 403 at the
proxy (`recentRelayFailures` in `curl $HTTPS_PROXY/__agentproxy/status`),
not a transient outage:

- **Blocked:** `commons.wikimedia.org`, `upload.wikimedia.org`,
  `en.wikipedia.org`, `archive.org`, `huggingface.co`,
  `datasets-server.huggingface.co`, `nih.gov`, `ncbi.nlm.nih.gov`,
  `openstax.org`
- **Reachable:** `github.com`/`raw.githubusercontent.com`, `pypi.org`,
  `files.pythonhosted.org`, `storage.googleapis.com`

Practical effect: the MediaPipe pose model (hosted on
`storage.googleapis.com`) downloaded fine —
`models/pose_landmarker_heavy.task` is real weights, not a stub. Gray's
Anatomy plates (Wikimedia-only) could not be fetched in this session. See
`assets/anatomy/README.md` for the workaround (run the fetch step
elsewhere, or get the domains allowlisted).

## What's validated (`tests/test_pipeline.py`)

All of these pass today and exercise real code paths, not mocks:

- Joint-angle math and torso-yaw estimation on synthetic-but-geometrically-
  real landmark sets.
- Occlusion opacity bounds and front/back behavior swap across yaw.
- Thin-plate-spline warp placing content correctly at target control
  points and leaving the rest of the canvas transparent.
- Muscle library loads 24 muscles spanning upper body / core / lower body,
  and both the Milestone 1 test case's 7 muscles and a `lower_body` group
  (for the squat-case follow-up the brief calls for) resolve correctly.
- **Real MediaPipe inference with the real downloaded model**: confirmed
  it correctly finds *no* person in a blank frame, and — pulled in
  separately from public-domain photos on `raw.githubusercontent.com`
  since that host is reachable — correctly detects all 33 landmarks on
  two real photos of people.
- **Full CLI run against a real photo turned into a short video**: pose
  detected, 5-muscle overlay built and warped, occlusion applied, 3-segment
  video assembled and concatenated (output duration = original + freeze
  duration, resolution preserved). Visually spot-checked (see PR/commit
  for a sample frame) — placeholder muscle shapes land in roughly the
  right torso/thigh region.

**Not yet validated** (needs the real test clip + real assets, both
blocked as described above): anatomical placement accuracy against a real
exercise pose, visual quality of actual muscle art, and — per the brief's
explicit requirement — professional sign-off on any of it. The catalog's
`validated_by_professional` field is `false` for every entry except the
Milestone 1 test case's 4 muscles + their mirrored pair (Latissimus Dorsi,
Triceps Brachii, Rectus Abdominis, Gluteus Maximus), which the brief states
were already approved; that field should be treated as unset elsewhere
until someone actually reviews the output.

## Running it

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python3 scripts/download_pose_model.py          # real weights, ~30MB
python3 tests/test_pipeline.py                  # should print "All checks passed."

python3 cli.py \
    --video input/test_clip_1.mov \
    --pause-time 1.0 \
    --freeze-duration 3.0 \
    --muscles latissimus_dorsi_r latissimus_dorsi_l triceps_brachii_r \
              triceps_brachii_l rectus_abdominis gluteus_maximus_r \
              gluteus_maximus_l \
    --output output/test_clip_1_annotated.mp4
```

(`ffmpeg` must be on `PATH`; `apt-get install -y ffmpeg` if it isn't.)

## Known limitations / next steps

1. **Upload `input/test_clip_1.mov`** (and, per the brief, a second clip
   emphasizing leg muscles — e.g. a squat) to actually run and validate
   Milestone 1's test case end-to-end.
2. **Populate real anatomical assets** — see `assets/anatomy/README.md`.
   Blocked on Wikimedia access from this sandbox.
3. **Occlusion is a 2-landmark yaw proxy**, not a true 3D reconstruction.
   The brief flags SMPL/SMPL-X body reconstruction as a path to a more
   general occlusion solution if a GPU becomes available — worth
   revisiting once the 2D approach has been checked against real footage
   and its failure modes are known.
4. **No pitch/roll estimate**, only yaw — a camera looking down/up at the
   subject, or a subject leaning heavily, isn't accounted for in the
   occlusion model yet.
5. **Segment cut points aren't frame-exact** — segment 1 stops and segment
   3 starts both computed from the requested `pause_time_s`, while the
   frozen frame is the *nearest* actual frame `cv2` seeks to; on some
   codecs/frame rates this can show a 1-frame mismatch at the freeze
   boundary. Not addressed since it's cosmetic and hasn't been checked
   against a real clip yet.
6. **Hebrew muscle names** (`name_he` in the catalog) are standard
   anatomical terminology but haven't been reviewed by the professional
   who's validating the rest of the output — flag alongside the other
   validation items.
