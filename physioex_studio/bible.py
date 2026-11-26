"""Style and character bible. Copy-exact blocks keep characters consistent across shots."""

STYLE = ("Next-gen AAA basketball video game cinematic, realistic 3D game-engine render, "
         "detailed skin shading, subtle game-like sheen, vertical 9:16")

QUALITY = "Sharp detail, consistent anatomy, no real-world logos, no text other than the PhysioEx sign."

CHARACTERS = {
    "PLAYER": (
        "PLAYER (Harbor #8): athletic male basketball player, mid-20s, brown skin, short dark fade haircut, "
        "light stubble, lean muscular build. Orange basketball jersey and shorts with navy trim, chest text "
        "\"HARBOR\", number 8 in white. Black compression sleeve on the right arm, black knee sleeve on the "
        "left knee, white crew socks, plain white basketball sneakers with orange accents"),
    "THERAPIST_F": (
        "THERAPIST: female physiotherapist, early 30s, light-medium skin, dark hair in a high bun, calm focused "
        "expression. Teal polo shirt with a small \"PhysioEx\" chest logo, dark navy trousers"),
    "THERAPIST_M": (
        "THERAPIST: male physiotherapist, early 30s, light skin, short brown hair, calm focused expression. "
        "Teal polo shirt with a small \"PhysioEx\" chest logo, dark navy trousers"),
}

SETS = {
    "ARENA": (
        "ARENA: indoor basketball arena at night, packed blurred crowd, bright ceiling floodlights with lens "
        "bloom, glossy reflective hardwood court, navy courtside LED boards reading \"PhysioEx\" "
        "(white \"Physio\", orange \"Ex\")"),
    "CLINIC": (
        "CLINIC: clean sports physiotherapy room, navy wall with a vertical light-wood slat panel, navy sign "
        "\"PhysioEx SPORTS PHYSIOTHERAPY\" (white \"Physio\", orange \"Ex\"), anatomical lower-leg poster, "
        "teal-padded treatment table, white cabinet, light wood floor"),
}

LIGHTING = {
    "ARENA": "strong top floodlights with lens bloom, dark stands, reflections on the hardwood",
    "CLINIC": "soft daylight from a side window with diagonal light shafts, gentle bounce light",
}

NEGATIVE = ("cartoon, anime, pixar style, low-poly, toy-like, live-action photo, extra limbs, extra fingers, "
            "distorted face, changing jersey number, text artifacts, real brand logos, swoosh, foot sliding, "
            "jitter, blur, watermark")

KEEP = ("Keep every character, outfit, the number 8 and the lighting identical to the start frame. "
        "Smooth, physically plausible motion, feet grounded, no camera shake.")
