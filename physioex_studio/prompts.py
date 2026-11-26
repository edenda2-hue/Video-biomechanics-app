from . import bible


def _chars(spec):
    out = []
    for c in spec.get("characters", []):
        out.append(bible.CHARACTERS.get(c, c))  # unknown key = literal custom block
    return ". ".join(out)


def image_prompt(spec):
    s = spec.get("set", "CLINIC")
    parts = [
        bible.STYLE + ".",
        _chars(spec) + ".",
        bible.SETS.get(s, s) + ".",
        f"Pose: {spec['pose']}.",
        f"Camera: {spec.get('camera_image', 'mid-low angle, full body, slightly off-center')}.",
        f"Lighting: {bible.LIGHTING.get(s, '')}.",
    ]
    if spec.get("references"):
        parts.append("Match the faces, outfits and room layout of the reference images, "
                     "but render them in the realistic AAA game style described above.")
    parts.append(bible.QUALITY)
    return " ".join(p for p in parts if p.strip(". "))


def video_prompt(spec):
    return (f"{spec['motion']} Camera: {spec.get('camera_motion', 'slow push-in')}. {bible.KEEP}")


def negative(spec):
    extra = spec.get("negative_extra")
    return bible.NEGATIVE + (", " + extra if extra else "")
