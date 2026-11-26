# Video-biomechanics-app

## PhysioEx Studio

Turns a short scene description into a finished vertical PhysioEx clip in the AAA basketball-video-game look.

```
scene.yaml ──► prompts ──► keyframe (image model + reference images) ──► animate (image-to-video)
                                                                         │
                                         QC contact sheet ◄──────────────┤
                                                                         ▼
                        finish: 720x1280 @24fps, grade, PhysioEx HUD, voice, end card ──► final.mp4
```

The 3D art comes from generative models on [fal.ai](https://fal.ai): Nano Banana or Flux for the start frame,
then Kling or Seedance for the motion. The tool writes the prompts from the style/character bible and does
all the editing locally with ffmpeg.

### Setup

```bash
pip install -r requirements.txt        # plus ffmpeg on PATH
export FAL_KEY=...                     # fal.ai API key (paid per generation)
```

### Use

```bash
python -m physioex_studio prompts  scenes/scene4_history.yaml          # only print/save prompts
python -m physioex_studio run      scenes/scene4_history.yaml          # full pipeline
python -m physioex_studio keyframe scenes/scene4_history.yaml --takes 3 # several start frames to choose from
python -m physioex_studio animate  scenes/scene4_history.yaml --keyframe out/scene4_history/keyframe_2.png
python -m physioex_studio finish   scenes/scene4_history.yaml --clip higgsfield_clip.mp4   # clip made elsewhere
python -m physioex_studio run      scenes/scene4_history.yaml --mock   # offline test, no generator
```

Output goes to `out/<scene id>/`: `keyframe_N.png`, `clip_N.mp4` + `clip_N_qc.png`, `<id>_final.mp4`.
Check every `_qc.png` for drifting faces, a changing number 8, extra fingers, sliding feet or real logos,
and re-roll (`--takes`) before finishing.

### Scene spec

See `scenes/scene4_history.yaml`. Key fields:

| field | meaning |
|---|---|
| `characters`, `set` | keys from `physioex_studio/bible.py` (`PLAYER`, `THERAPIST_F`, `THERAPIST_M`, `ARENA`, `CLINIC`) or a full custom description |
| `pose`, `camera_image` | the start frame |
| `motion`, `camera_motion` | one action, with timing |
| `references` | images sent to the image model to keep faces, kit and room consistent |
| `audio` | voice/music track for the final cut (silent if omitted) |
| `grade` | `none`, `polish` (for AAA clips) or `restyle` (heavier cinematic grade for simple 3D) |
| `overlay` | chapter tag, speech bubbles, case notes and captions with timings (Hebrew works, RTL via libass) |
| `end_card` | add the 1.8 s navy PhysioEx card |

Model ids live in `physioex_studio/fal.py` (`MODELS`), so a newer model is a one-line change.
