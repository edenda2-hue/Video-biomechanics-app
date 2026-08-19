# Video Biomechanics App

Turns a real training/sports video into a professional anatomical-biomechanical
analysis: **upload → pick a frame → freeze → the person becomes an anatomical
figure → primary muscles are highlighted with labels → the figure smoothly
turns back into the person → the video resumes.**

The original video is always the source of truth. The camera, background,
equipment, floor and lighting never move or regenerate — only the human body
is ever replaced, and only for the duration of the freeze.

This repo implements the MVP scope from the product spec (section 18): one
freeze/anatomy/muscle-highlight/resume cycle, done reliably, end to end.

## Architecture

A monorepo with two packages, mirroring the four-way responsibility split
from the spec (section 16):

```
web/     React + TypeScript wizard UI, and the "CV Engine"
           (client-side pose estimation + human segmentation via
           MediaPipe Tasks Vision — runs in the browser, no server GPU needed)
server/  Node + TypeScript API: OpenAI integration, quality control,
           label layout, and the "Video Engine" (ffmpeg + sharp compositing)
```

| Responsibility (spec §16) | Where |
|---|---|
| Visual/exercise understanding, anatomical generation & refinement, kinesiological reasoning, muscle selection & highlighting | `server/src/lib/openai/*` (calls OpenAI; `realProvider.ts` vs. offline `mockProvider.ts`) |
| Pose estimation, human segmentation, coordinate mapping, alignment validation | `web/src/cv/*` (MediaPipe Pose Landmarker + Image Segmenter, in-browser) |
| Workflow, approvals, quality control, regeneration logic | `server/src/routes/*`, `server/src/lib/quality.ts`, `server/src/lib/labelLayout.ts` |
| Frame extraction, freeze, body-only transition, compositing, audio, resume, export | `server/src/lib/ffmpeg.ts`, `server/src/lib/compositing.ts` |

### The core mechanic: body-only transition

The whole product hinges on one rule: only the human body changes; the frame
around it is pixel-identical to the source video. This is implemented
literally, not just as a prompt instruction:

1. The confirmed frame is extracted directly from the source video (ffmpeg,
   `-i input -ss t -frames:v 1`) — never synthesized.
2. The CV Engine produces a person/background segmentation mask for that
   frame.
3. For every frame of the transition, `lib/compositing.ts` computes
   `result = original*(1 - mask*alpha) + anatomy*(mask*alpha)` per pixel.
   Outside the mask, `alpha` never affects the output — background pixels
   are always the literal original bytes. Inside the mask, `alpha` ramps
   0→1 (transition in), holds at 1 (frozen anatomy + muscle highlight +
   labels), then 1→0 (transition out).
4. That freeze segment is encoded and spliced into the original video before
   and after the freeze point (`lib/ffmpeg.ts#assembleFinalVideo`), with the
   original audio held silent for the freeze duration so audio/video stay in
   sync when the clip resumes.

The Preview step (`web/src/components/PreviewStep.tsx`) renders the exact
same blend live in a `<canvas>` so you can scrub/tune timing before
rendering the final MP4.

## Quality control

Two gates, matching spec §5–6:

1. **Automatic**: after each OpenAI anatomy generation, the CV Engine
   re-runs pose estimation on the candidate image; the server scores pose
   alignment (per-joint distance vs. the original frame) and background
   consistency (pixel diff outside the mask) and rejects/regenerates
   silently up to `MAX_REGENERATE_ATTEMPTS` (`server/src/config.ts`) without
   ever showing a failed attempt to the user.
2. **Manual**: once automatic QC passes, the user gets the ORIGINAL ↔
   ANATOMY slider (`ApproveAnatomyStep.tsx`) to approve or force a
   regeneration.

## Running it locally

Requires Node.js 22+ and `ffmpeg`/`ffprobe` on `PATH` (an OpenAI API key is
optional — see below).

```bash
git clone https://github.com/edenda2-hue/Video-biomechanics-app.git
cd Video-biomechanics-app
git checkout claude/biomechanics-video-analysis-qa3xmg

npm run setup   # checks Node/ffmpeg, installs deps, creates server/.env
npm run dev     # starts the API (8787) and the web app (5173) together
```

`npm run setup` fails fast with a clear message (and OS-specific install
command) if Node or ffmpeg is missing. Open **http://localhost:5173** and
walk through the 9-step wizard.

To run the two halves separately instead: `npm run dev:server` and
`npm run dev:web` in two terminals.

### Without an OpenAI key

`server/src/lib/openai/mockProvider.ts` is a deterministic, offline stand-in
(stylizes the masked person region, tints muscle regions) so the full
pipeline — including ffmpeg compositing and export — is exercisable without
any external API calls. The server logs a warning and uses it automatically
whenever `OPENAI_API_KEY` is unset.

The CV Engine has the same fallback: set `VITE_CV_MOCK=1` when running the
web dev server to skip the MediaPipe model downloads and use a synthetic
pose/mask instead (useful if the MediaPipe model CDN isn't reachable from
your network).

### Automated checks

- `server/scripts/e2e-smoke.mjs` drives the entire backend pipeline against
  a synthetic ffmpeg-generated test video and the mock OpenAI provider, then
  verifies the exported MP4's resolution/fps/duration/audio with `ffprobe`.
  Run with the server up: `node server/scripts/e2e-smoke.mjs`.
- `npm run typecheck` (root) typechecks both packages.

## Known MVP limitations

- **Muscle highlight masking** uses the same full-body person mask as
  anatomy generation, guided by a prompt naming the target muscles and their
  approximate coordinates — there's no per-muscle segmentation, since that
  would need a much larger anatomical CV model than fits this MVP. Documented
  as a candidate follow-up.
- **Regeneration budget** (`MAX_REGENERATE_ATTEMPTS`, default 3) is
  per-session and doesn't reset; it exists to bound OpenAI image-edit spend
  per freeze frame.
- Section 10's advanced biomechanics (joint angles, force vectors, moment
  arms, COM, GRF) is explicitly out of scope for this MVP per spec §18 and
  isn't implemented.
- Video engine assumes a single freeze point per export (matches the MVP
  scope of spec §18: "one workflow, done well").
