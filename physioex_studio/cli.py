"""PhysioEx Studio CLI.

  python -m physioex_studio prompts  scenes/scene4_history.yaml
  python -m physioex_studio keyframe scenes/scene4_history.yaml [--takes 2]
  python -m physioex_studio animate  scenes/scene4_history.yaml [--keyframe out/.../keyframe_1.png]
  python -m physioex_studio finish   scenes/scene4_history.yaml --clip my_clip.mp4
  python -m physioex_studio run      scenes/scene4_history.yaml        # everything, end to end
Add --mock to any step to test the pipeline offline without the generator.
"""
import argparse, glob, json, os, sys
import yaml
from . import prompts, fal, edit


def load(path):
    spec = yaml.safe_load(open(path, encoding="utf-8"))
    base = os.path.dirname(os.path.abspath(path))
    root = os.path.dirname(base)
    def res(p):
        if p is None or os.path.isabs(p):
            return p
        for b in (base, root, os.getcwd()):
            if os.path.exists(os.path.join(b, p)):
                return os.path.join(b, p)
        return p
    spec["references"] = [res(p) for p in spec.get("references", [])]
    spec["audio"] = res(spec.get("audio"))
    spec["_out"] = os.path.join(root, "out", spec["id"])
    os.makedirs(spec["_out"], exist_ok=True)
    return spec


def cmd_prompts(spec, a):
    p = {"image": prompts.image_prompt(spec), "video": prompts.video_prompt(spec),
         "negative": prompts.negative(spec)}
    path = os.path.join(spec["_out"], "prompts.json")
    json.dump(p, open(path, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
    for k, v in p.items():
        print(f"\n=== {k.upper()} ===\n{v}")
    print(f"\n[saved] {path}")
    return p


def cmd_keyframe(spec, a):
    p = prompts.image_prompt(spec)
    outs = []
    for i in range(1, a.takes + 1):
        out = os.path.join(spec["_out"], f"keyframe_{i}.png")
        if a.mock:
            edit.mock_keyframe(spec["references"][-1], out)
        else:
            model = a.image_model or ("nano-banana" if spec["references"] else "flux-ultra")
            fal.keyframe(model, p, spec["references"], out)
        print(f"[keyframe] {out}"); outs.append(out)
    return outs


def _latest(spec, pattern):
    files = sorted(glob.glob(os.path.join(spec["_out"], pattern)), key=os.path.getmtime)
    if not files:
        sys.exit(f"no {pattern} in {spec['_out']}; run the previous step or pass a path")
    return files[-1]


def cmd_animate(spec, a):
    kf = a.keyframe or _latest(spec, "keyframe_*.png")
    outs = []
    for i in range(1, a.takes + 1):
        out = os.path.join(spec["_out"], f"clip_{i}.mp4")
        if a.mock:
            edit.mock_animate(kf, spec.get("duration", 7), out)
        else:
            fal.animate(a.video_model, prompts.video_prompt(spec), kf, prompts.negative(spec),
                        spec.get("gen_duration", 10), out)
        sheet = edit.contact_sheet(out, out.replace(".mp4", "_qc.png"))
        print(f"[clip] {out}\n[qc]   {sheet}"); outs.append(out)
    return outs


def cmd_finish(spec, a):
    clip = a.clip or _latest(spec, "clip_*.mp4")
    out = a.out or os.path.join(spec["_out"], f"{spec['id']}_final.mp4")
    edit.finish(clip, spec, out, spec["_out"])
    sheet = edit.contact_sheet(out, out.replace(".mp4", "_qc.png"))
    print(f"[final] {out}\n[qc]    {sheet}")
    return out


def cmd_run(spec, a):
    cmd_prompts(spec, a)
    a.keyframe = cmd_keyframe(spec, a)[0]
    a.clip = cmd_animate(spec, a)[0]
    return cmd_finish(spec, a)


def main(argv=None):
    ap = argparse.ArgumentParser(prog="physioex_studio", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["prompts", "keyframe", "animate", "finish", "run"])
    ap.add_argument("scene", help="scene spec .yaml")
    ap.add_argument("--mock", action="store_true", help="offline stand-ins instead of the generator")
    ap.add_argument("--takes", type=int, default=1, help="how many variants to generate")
    ap.add_argument("--image-model", choices=[k for k, m in fal.MODELS.items() if m["kind"] == "image"])
    ap.add_argument("--video-model", default="kling",
                    choices=[k for k, m in fal.MODELS.items() if m["kind"] == "video"])
    ap.add_argument("--keyframe", help="use this start frame instead of the latest one")
    ap.add_argument("--clip", help="use this clip for finish (e.g. one made in Higgsfield)")
    ap.add_argument("--out", help="final output path")
    a = ap.parse_args(argv)
    spec = load(a.scene)
    globals()[f"cmd_{a.command}"](spec, a)
