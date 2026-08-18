# Video Biomechanics App

Interactive video anatomy overlay: upload any exercise/movement video, pick
a moment to pause on and a set of muscles to highlight, and the pipeline
freezes the video there, fades in an anatomically-placed muscle overlay
fitted to the detected pose at that exact frame, holds it, then resumes
playback. General-purpose by design — not built around any one exercise.

**תקציר (עברית):** ה-pipeline הכללי של Milestone 1 רץ בפועל על מקרה הבדיקה
האמיתי (`input/test_clip_1.mov` — תרגיל bar hold, עצירה בשנייה 1, השהיה 5
שניות). 6 מתוך 7 השרירים המבוקשים (Latissimus Dorsi, Triceps Brachii,
Gluteus Maximus — כל אחד בשני הצדדים) מוצגים כעת עם איור אנטומי אמיתי
(שסופק ע"י המשתמש, נוצר ב-AI, לא מ-Gray's 1918 בגלל חסימת הרשת ל-Wikimedia
בסביבה הזו). Rectus Abdominis עדיין placeholder כי לא סופק איור עבורו.
פרטים מלאים בהמשך המסמך (באנגלית) ובקובץ `assets/anatomy/README.md`.

## Status: Milestone 1

The general pipeline has been run end-to-end against the real test clip
described in the project brief: `input/test_clip_1.mov` (an outdoor bar
front-lever/hold, 4K portrait, iPhone), paused at t=1s, held for 5s, with
Latissimus Dorsi / Triceps Brachii / Gluteus Maximus (each bilateral) and
Rectus Abdominis. 6 of those 7 muscle instances now render with real
curated anatomical art (see "Anatomical art" below); Rectus Abdominis is
still the placeholder shape since no source art exists for it yet.

Running the real clip through the real pipeline surfaced (and fixed) a
genuine bug -- see "Key technical decisions" -- that synthetic test data
alone hadn't caught, which is exactly why this step mattered before
calling Milestone 1 done.

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
| `compositing/warp.py` | Warps a source image so its control points land on target (pose-derived) points — thin-plate spline for ≥3 well-spread points, similarity transform (2 points, or ≥3 nearly-collinear ones) otherwise. |
| `compositing/occlusion.py` | Continuous opacity from the angle between the camera's viewing axis and each muscle's estimated body-surface normal (derived from torso yaw + the muscle's declared facing) — not a per-exercise rule. |
| `compositing/overlay.py` | Combines warped, opacity-adjusted muscles into one RGBA layer per pose frame, and alpha-composites that layer onto a video frame at a given fade level. |
| `video/ffmpeg_utils.py` | `ffprobe`/`ffmpeg` subprocess wrappers — resolution/fps/duration/audio-presence detection. |
| `video/segments.py` | Builds and concatenates the 3 segments for any duration/resolution/fps/codec input. |
| `cli.py` | Orchestrates all of the above from command-line arguments. |
| `tests/test_pipeline.py` | Dependency-free smoke tests (see below). |

## Key technical decisions

- **Gray's Anatomy (1918), not Netter, as the intended long-term source.**
  Netter Atlas is commercially licensed; Gray's 1918 (20th edition) is
  unambiguously Public Domain. `assets/anatomy/README.md` documents the
  intended sourcing/curation workflow via Wikimedia Commons. For this
  round, 6 muscles instead use an AI-generated reference sheet the project
  owner supplied directly (confirmed with them it's their own AI output,
  not a scraped/commercial image, before using it) — see "Anatomical art"
  below. It is not Gray's 1918 and doesn't replace the intended sourcing
  plan; it unblocked visual validation of the warp/occlusion pipeline
  while Wikimedia stays unreachable from this sandbox.
- **Image-based muscle art, not vector shapes.** The earlier chat-only
  prototype tried vector-drawn muscle fibers and it wasn't organic-looking
  — this rejects that approach again: every placeholder that still exists
  (Rectus Abdominis, and anything else without curated art) is
  logged/labeled as such everywhere it appears, and the real asset path is
  committed to curated raster cutouts warped onto the pose.
- **Thin-plate spline warp for well-spread control points, similarity
  transform (rigid rotate+scale+translate, via closed-form Umeyama
  least-squares) for exactly 2 points or nearly-collinear ones** —
  implemented with `scipy.interpolate.RBFInterpolator` for TPS rather than
  `opencv-contrib`'s TPS transformer, so the project only depends on plain
  `opencv-python`. The collinear fallback exists because of a real bug
  found running the actual test clip: the test pose has a fully extended
  arm (front lever, hand gripping the bar overhead), so Triceps Brachii's
  shoulder/elbow/wrist control points landed almost exactly on one line.
  TPS is mathematically defined for collinear points, but it extrapolates
  unboundedly for any source content off that line, and the triceps cutout
  (which has real width perpendicular to the arm) got shredded into
  repeated stretched strips. This isn't a one-clip quirk — any
  fully-extended-limb pose (pull-ups, planks, presses) hits the same
  failure mode for any muscle spanning that limb, so the fix
  (`compositing/warp.py`'s `_is_nearly_collinear` check, via PCA
  minor/major spread ratio) is generic, not a patch for this video.
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

## Anatomical art

6 of 24 catalog muscles (`latissimus_dorsi_{r,l}`, `triceps_brachii_{r,l}`,
`gluteus_maximus_{r,l}`) now have curated cutouts in
`assets/anatomy/muscles/`, sourced from an AI-generated reference sheet
the project owner provided directly and confirmed was their own AI output
(not scraped or commercial art) — see `assets/anatomy/README.md`
"Current status" for the full provenance note and the segmentation method
(`scripts/segment_muscle_from_reference.py`, saturation-keyed background
removal). `rectus_abdominis` and everything else in the catalog still
render as the placeholder shape.

Control points for these 6 were placed by visual estimate on a pixel grid,
not clicked interactively with `scripts/pick_control_points.py` — treat
the placement as a first pass. Visual spot-check against the real test
clip (see below) shows plausible placement and correct behavior under a
fully-extended-arm pose, but it has **not** been reviewed by the
professional who validated this muscle set in the original brief.

## What's validated

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
- **Full CLI run against the real test clip**: `input/test_clip_1.mov`
  (4K portrait, front-lever/bar-hold, fully extended arms), paused at the
  requested t=1s (landed on the nearest actual frame, t=0.875s, due to the
  clip's ~21.5fps), held 5s, 7-muscle overlay (6 curated + 1 placeholder)
  built/warped/occlusion-applied, 3-segment video assembled and
  concatenated (output duration = original 2.78s + 5s freeze ≈ 7.8s,
  resolution 2160x3840 preserved, iPhone rotation metadata handled
  correctly by both the cv2 frame extraction and the ffmpeg segments).
  Visually spot-checked at full res — see the sample frames sent to the
  project owner. This run is also what surfaced the collinear-control-point
  warp bug described above; the fix was verified by re-running this same
  clip and confirming the shredding artifact was gone.

**Not yet validated** (per the brief's explicit requirement): professional
sign-off on the actual output — placement accuracy, visual quality, and
Hebrew terminology. The catalog's `validated_by_professional` field is
`false` for every entry except the Milestone 1 test case's 4 muscles +
their mirrored pair (Latissimus Dorsi, Triceps Brachii, Rectus Abdominis,
Gluteus Maximus), which the brief states were already approved *as a
concept* — that predates, and doesn't substitute for, review of this
specific rendered output. The leg-emphasis (squat) validation pass the
brief also calls for hasn't been run — no second test clip yet.

## Running it

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python3 scripts/download_pose_model.py          # real weights, ~30MB
python3 tests/test_pipeline.py                  # should print "All checks passed."

python3 cli.py \
    --video input/test_clip_1.mov \
    --pause-time 1.0 \
    --freeze-duration 5.0 \
    --muscles latissimus_dorsi_r latissimus_dorsi_l triceps_brachii_r \
              triceps_brachii_l rectus_abdominis gluteus_maximus_r \
              gluteus_maximus_l \
    --output output/test_clip_1_annotated.mp4
```

(`ffmpeg` must be on `PATH`; `apt-get install -y ffmpeg` if it isn't. The
real 4K test clip takes several minutes to render — see limitation below.)

## Known limitations / next steps

1. **4K rendering is slow** (~7.5 minutes for a 5s freeze on the real
   3840x2160-sensor test clip), almost entirely in per-frame Python/OpenCV
   compositing of the freeze segment's image sequence. Worth profiling and
   optimizing (e.g. build the overlay once and reuse it across fade
   frames instead of recompositing from scratch, or vectorize/batch the
   alpha blend) before this is used on longer freezes or many muscles.
2. **Curated art covers 6 of 24 catalog muscles**, all from a user-supplied
   AI-generated reference sheet rather than the intended Gray's 1918
   source — see "Anatomical art" above. Populating the rest, and replacing
   these 6 with Gray's 1918 cutouts per the original plan, is still
   blocked on Wikimedia access from this sandbox.
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
   boundary. Confirmed on the real clip: requesting `--pause-time 1.0`
   landed on the actual frame at t=0.875s (the clip's frame rate is an
   unusual ~21.5fps, an iPhone variable-frame-rate artifact) — close
   enough not to be visually jarring here, but not literally exact.
   Cosmetic; not addressed this round.
6. **Hebrew muscle names** (`name_he` in the catalog) are standard
   anatomical terminology but haven't been reviewed by the professional
   who's validating the rest of the output — flag alongside the other
   validation items.
