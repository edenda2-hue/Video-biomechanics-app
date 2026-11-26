"""ffmpeg editing: normalize, optional grade, HUD burn-in, audio, end card, QC contact sheet."""
import os, shlex, subprocess, tempfile
from . import overlay

W, H, FPS = 720, 1280, 24

# "polish" is gentle (for clips that already have the AAA look);
# "restyle" is the heavier cinematic grade used to lift simpler 3D renders.
GRADES = {
    "none": "",
    "polish": ("eq=contrast=1.04:saturation=1.05,unsharp=5:5:0.35,vignette=angle=PI/5,noise=alls=3:allf=t"),
    "restyle": ("curves=all='0/0 0.25/0.21 0.5/0.5 0.8/0.83 1/0.97',eq=contrast=1.06:saturation=1.05,"
                "colorbalance=rs=-0.03:bs=0.04:gh=0.01:bh=-0.01,unsharp=5:5:0.5,vignette=angle=PI/4.5,"
                "noise=alls=4:allf=t"),
}


def sh(cmd):
    print("+", " ".join(shlex.quote(c) for c in cmd[:6]), "...")
    subprocess.run(cmd, check=True)


def probe_duration(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                         capture_output=True, text=True, check=True).stdout.strip()
    return float(out)


def has_audio(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index",
                          "-of", "csv=p=0", path], capture_output=True, text=True).stdout.strip()
    return bool(out)


def finish(clip, spec, out, workdir):
    dur = float(spec.get("duration", 7))
    ov = spec.get("overlay", {})
    ass = overlay.build(ov, dur, os.path.join(workdir, "hud.ass"))
    src_d = probe_duration(clip)
    fit = spec.get("fit", "auto")
    speed = ""
    if fit == "stretch" or (fit == "auto" and src_d < dur * 0.9 and src_d >= dur / 1.6):
        speed = f"setpts=PTS*{dur/src_d:.4f},"   # mild slow-down for short clips
    pad = f",tpad=stop_mode=clone:stop_duration={dur}" if src_d < dur else ""
    push = float(spec.get("push_in", 0.0))
    zoom = ""
    if push > 0:
        zoom = (f",scale=eval=frame:w='2*trunc({W}*(1+{push}*t/{dur}))':h='2*trunc({H}*(1+{push}*t/{dur}))'"
                f":flags=lanczos,crop={W}:{H}:x='(iw-ow)/2':y='(ih-oh)*0.4'")
    grade = GRADES[spec.get("grade", "polish")]
    vf = (f"[0:v]{speed}scale={W}:{H}:force_original_aspect_ratio=increase:flags=lanczos,crop={W}:{H},"
          f"fps={FPS},setsar=1{pad}{zoom}" + (f",{grade}" if grade else "") +
          f",subtitles={ass},trim=0:{dur},setpts=PTS-STARTPTS,format=yuv420p[v]")
    audio = spec.get("audio")
    cmd = ["ffmpeg", "-y", "-v", "error", "-i", clip]
    if audio:
        cmd += ["-i", audio]
        amap = "1:a"
    else:
        cmd += ["-f", "lavfi", "-t", str(dur), "-i", "anullsrc=r=48000:cl=stereo"]
        amap = "1:a"
    body = os.path.join(workdir, "body.mp4") if spec.get("end_card") else out
    cmd += ["-filter_complex", vf, "-map", "[v]", "-map", amap, "-t", str(dur),
            "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-c:a", "aac", "-b:a", "160k",
            "-ar", "48000", "-ac", "2", "-movflags", "+faststart", body]
    sh(cmd)
    if spec.get("end_card"):
        ec = os.path.join(workdir, "endcard.mp4")
        ed = float(spec.get("end_card_duration", 1.8))
        eass = overlay.end_card(ed, os.path.join(workdir, "endcard.ass"))
        sh(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", f"color=c=0x0F1A2E:s={W}x{H}:r={FPS}:d={ed}",
            "-f", "lavfi", "-t", str(ed), "-i", "anullsrc=r=48000:cl=stereo",
            "-vf", f"subtitles={eass},format=yuv420p", "-c:v", "libx264", "-crf", "17", "-c:a", "aac",
            "-ar", "48000", "-ac", "2", "-shortest", ec])
        sh(["ffmpeg", "-y", "-v", "error", "-i", body, "-i", ec, "-filter_complex",
            "[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]", "-map", "[v]", "-map", "[a]",
            "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-c:a", "aac", "-movflags", "+faststart", out])
    return out


def contact_sheet(video, out, n=6):
    d = probe_duration(video)
    with tempfile.TemporaryDirectory() as td:
        frames = []
        for i in range(n):
            t = d * (i + 0.5) / n
            f = os.path.join(td, f"{i}.png")
            sh(["ffmpeg", "-y", "-v", "error", "-ss", f"{t:.2f}", "-i", video, "-frames:v", "1",
                "-vf", "scale=-2:640", f])
            frames.append(f)
        ins = sum((["-i", f] for f in frames), [])
        sh(["ffmpeg", "-y", "-v", "error", *ins, "-filter_complex",
            "".join(f"[{i}]" for i in range(n)) + f"hstack=inputs={n}", out])
    return out


def mock_keyframe(ref, out):
    """Offline stand-in for the generator: fits a reference image to 9:16."""
    sh(["ffmpeg", "-y", "-v", "error", "-i", ref, "-vf",
        f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H}", "-frames:v", "1", out])
    return out


def mock_animate(image, dur, out):
    sh(["ffmpeg", "-y", "-v", "error", "-loop", "1", "-i", image, "-t", str(dur), "-vf",
        f"scale=eval=frame:w='2*trunc({W}*(1+0.05*t/{dur}))':h='2*trunc({H}*(1+0.05*t/{dur}))',"
        f"crop={W}:{H},fps={FPS},format=yuv420p", "-c:v", "libx264", "-crf", "18", out])
    return out
