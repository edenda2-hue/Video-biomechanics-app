#!/usr/bin/env python3
"""Download Gray's Anatomy (1918, Public Domain) plates from Wikimedia
Commons into assets/anatomy/source/.

IMPORTANT: This cannot run inside the sandbox this pipeline was built in --
that environment's egress policy blocks commons.wikimedia.org,
upload.wikimedia.org, en.wikipedia.org, archive.org, and huggingface.co
outright (403 at the proxy, confirmed during Milestone 1 development; see
README.md "Network constraints" for the full list of what was and wasn't
reachable). Run this script from a machine/session with normal internet
access, or once those hosts are allowlisted for this project's sandbox.

Usage:
    python3 scripts/fetch_anatomy_plates.py --list
    python3 scripts/fetch_anatomy_plates.py --plate "Gray378.png" --plate "Gray379.png"

Wikimedia Commons category to browse for the right plates:
    https://commons.wikimedia.org/wiki/Category:Gray%27s_Anatomy_plates

Every file in that category is public domain (published 1918, US) -- no
license/attribution work needed for this project's purposes, but keep the
Commons file page URL noted next to whatever you save (see the sidecar
convention below) in case a professional reviewer wants to check the
original plate.
"""
from __future__ import annotations

import argparse
import pathlib
import sys
import urllib.parse
import urllib.request

COMMONS_API = "https://commons.wikimedia.org/w/api.php"
OUT_DIR = pathlib.Path(__file__).resolve().parent.parent / "assets" / "anatomy" / "source"


def commons_file_url(filename: str) -> str:
    """Resolve a Commons File: page name to its direct image URL via the
    MediaWiki API (avoids hardcoding Commons' md5-hash directory scheme)."""
    params = {
        "action": "query", "format": "json", "prop": "imageinfo",
        "iiprop": "url", "titles": f"File:{filename}",
    }
    url = COMMONS_API + "?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url, timeout=30) as resp:
        import json
        data = json.load(resp)
    pages = data["query"]["pages"]
    page = next(iter(pages.values()))
    return page["imageinfo"][0]["url"]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--plate", action="append", default=[], metavar="FILENAME",
                         help="Commons filename, e.g. 'Gray378.png' (repeatable)")
    parser.add_argument("--out-dir", type=pathlib.Path, default=OUT_DIR)
    parser.add_argument("--list", action="store_true",
                         help="Print the category browse URL and exit (no download)")
    args = parser.parse_args()

    if args.list or not args.plate:
        print("Browse plates here and pass their filenames with --plate:")
        print("  https://commons.wikimedia.org/wiki/Category:Gray%27s_Anatomy_plates")
        return 0

    args.out_dir.mkdir(parents=True, exist_ok=True)
    for filename in args.plate:
        try:
            url = commons_file_url(filename)
        except Exception as e:  # noqa: BLE001 -- surface any network/API failure plainly
            print(f"FAILED to resolve {filename}: {e}", file=sys.stderr)
            continue
        dest = args.out_dir / filename
        print(f"{filename}\n  {url}\n  -> {dest}")
        urllib.request.urlretrieve(url, dest)
        # Keep provenance next to the file for the professional-validation step.
        (args.out_dir / f"{filename}.source_url.txt").write_text(
            f"{url}\nhttps://commons.wikimedia.org/wiki/File:{filename}\n", encoding="utf-8"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
