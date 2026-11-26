"""Builds the PhysioEx HUD (chapter tag, speech bubbles, case notes, captions, logo bug) as an .ass file.
libass renders Hebrew right-to-left correctly, so captions can be Hebrew or English."""
W, H = 720, 1280
NAVY, ORANGE, WHITE, DARK = "&H2E1A0F&", "&H3B8CF5&", "&HFFFFFF&", "&H1A1A1A&"
FONT = "DejaVu Sans"


def _t(s):
    m, sec = divmod(max(s, 0), 60)
    return f"0:{int(m):02d}:{sec:05.2f}"


def _rr(w, h, r):
    k = r * 0.45
    return (f"m {r} 0 l {w-r} 0 b {w-k} 0 {w} {k} {w} {r} l {w} {h-r} b {w} {h-k} {w-k} {h} {w-r} {h} "
            f"l {r} {h} b {k} {h} 0 {h-k} 0 {h-r} l 0 {r} b 0 {k} {k} 0 {r} 0")


def _circle(d):
    r = d / 2; k = r * 0.55
    return (f"m {r} 0 b {r+k} 0 {d} {r-k} {d} {r} b {d} {r+k} {r+k} {d} {r} {d} "
            f"b {r-k} {d} 0 {r+k} 0 {r} b 0 {r-k} {r-k} 0 {r} 0")


class _Ass:
    def __init__(self):
        self.ev = []

    def shape(self, a, b, x, y, path, col, alpha="&H00&", fi=200, fo=200, layer=0):
        self.ev.append(f"Dialogue: {layer},{_t(a)},{_t(b)},S,,0,0,0,,"
                       f"{{\\an7\\pos({x},{y})\\p1\\bord0\\shad0\\1c{col}\\1a{alpha}\\fad({fi},{fo})}}{path}")

    def text(self, a, b, x, y, s, size, col, an=7, bold=1, sp=0, fi=200, fo=200, layer=2):
        self.ev.append(f"Dialogue: {layer},{_t(a)},{_t(b)},S,,0,0,0,,"
                       f"{{\\an{an}\\pos({x},{y})\\fn{FONT}\\fs{size}\\b{bold}\\fsp{sp}\\1c{col}\\bord0\\shad0"
                       f"\\fad({fi},{fo})}}{s}")


def build(ov, duration, out_path):
    """ov: the 'overlay' dict of a scene spec."""
    a = _Ass(); END = duration
    if ov.get("chapter"):
        w = 30 + 13 * len(ov["chapter"])
        a.shape(0, END, 24, 40, _rr(w, 46, 23), "&H0D0D0D&", "&H30&", 0, 0)
        a.text(0, END, 44, 52, ov["chapter"], 22, ORANGE, sp=2, fi=0, fo=0)

    for bb in ov.get("bubbles", []):
        x, y, w = bb.get("x", 360), bb.get("y", 215), bb.get("w", 24 + 14 * len(bb["text"]))
        s, e = bb["start"], bb.get("end", END)
        a.shape(s, e, x, y, _rr(w, 58, 22), WHITE, fi=150, fo=120, layer=1)
        right = bb.get("tail", "left") == "right"
        tx = x + (w - 60 if right else 40)
        a.shape(s, e, tx, y + 56, f"m 0 0 l 26 0 l {22 if right else 4} 22", WHITE, fi=150, fo=120, layer=1)
        a.text(s, e, x + w // 2, y + 29, bb["text"], 26, DARK, an=5, fi=150, fo=120)

    n = ov.get("notes")
    if n:
        x, y, w = n.get("x", 368), n.get("y", 24), n.get("w", 330)
        h = 48 + 28 * len(n["items"])
        s = n.get("start", n["items"][0]["at"] - 0.4)
        a.shape(s, END, x, y, _rr(w, h, 18), NAVY, "&H10&", 300, 0)
        a.text(s, END, x + 22, y + 14, n.get("title", "CASE NOTES"), 20, ORANGE, sp=3, fi=300, fo=0)
        for i, it in enumerate(n["items"]):
            yy = y + 48 + 28 * i
            a.shape(it["at"], END, x + 22, yy, _circle(18), ORANGE, fi=300, fo=0, layer=2)
            a.shape(it["at"], END, x + 28, yy + 6, _circle(6), WHITE, fi=300, fo=0, layer=3)
            a.text(it["at"], END, x + 50, yy - 3, it["text"], 22, WHITE, bold=0, fi=300, fo=0)

    caps = ov.get("captions", [])
    cy = ov.get("caption_center_y", 1100)
    for i, c in enumerate(caps):
        lines = c["text"].split("\n")
        h = 34 + 38 * len(lines); y = cy - h // 2
        fo = 0 if i == len(caps) - 1 else 250
        a.shape(c["start"], c.get("end", END), 40, y, _rr(W - 80, h, 16), "&H141414&", "&H38&", 150, fo)
        a.text(c["start"], c.get("end", END), W // 2, y + h // 2, "\\N".join(lines), 25, WHITE, an=5,
               bold=0, fi=150, fo=fo)

    if ov.get("logo", True):
        a.shape(0, END, W - 164, H - 62, _rr(140, 44, 22), "&H0D0D0D&", "&H30&", 0, 0)
        a.text(0, END, W - 94, H - 40, "Physio{\\1c" + ORANGE + "}Ex", 24, WHITE, an=5, fi=0, fo=0)

    hdr = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {W}
PlayResY: {H}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: S,{FONT},24,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(hdr + "\n".join(a.ev) + "\n")
    return out_path


def end_card(duration, out_path):
    a = _Ass()
    a.text(0, duration, W // 2, H // 2 - 20, "Physio{\\1c" + ORANGE + "}Ex", 96, WHITE, an=5, fi=300, fo=0)
    a.text(0, duration, W // 2, H // 2 + 60, "SPORTS PHYSIOTHERAPY", 26, WHITE, an=5, bold=0, sp=6,
           fi=500, fo=0)
    return build_raw(a, out_path)


def build_raw(a, out_path):
    tmp = out_path + ".tmp"
    build({"logo": False}, 0.1, tmp)
    hdr = open(tmp, encoding="utf-8").read().split("[Events]")[0]
    import os; os.remove(tmp)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(hdr + "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
                + "\n".join(a.ev) + "\n")
    return out_path
