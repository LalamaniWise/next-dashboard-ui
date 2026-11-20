"""Download the ready-made Piper voices offered on the Create video page.

    python ai/voice/get_voices.py

Each voice is about 63 MB and is saved in ai/voice/voices (git-ignored).
"""

import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "service"))
from config import PIPER_LIBRARY, VOICE_DIR  # noqa: E402

BASE_URL = "https://huggingface.co/rhasspy/piper-voices/resolve/main"


def fetch(url, path):
    if os.path.exists(path):
        print(f"already have {os.path.basename(path)}")
        return
    print(f"downloading {os.path.basename(path)}")
    with urllib.request.urlopen(url, timeout=120) as resp, open(path + ".part", "wb") as fh:
        while chunk := resp.read(1024 * 1024):
            fh.write(chunk)
    os.replace(path + ".part", path)


def main():
    os.makedirs(VOICE_DIR, exist_ok=True)
    for voice in PIPER_LIBRARY.values():
        for name in (voice["file"], voice["file"] + ".json"):
            fetch(f"{BASE_URL}/{voice['path']}/{name}", os.path.join(VOICE_DIR, name))


if __name__ == "__main__":
    main()
