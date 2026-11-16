"""Print what to read for each scene, and what to name each recording.

    python recording_script.py lessons/gr12-maths-stationary-points.json
    python recording_script.py lessons/lesson.json --out script.txt

Easiest: use ai/voice/recorder.html, which shows each scene and names the
files for you. Use this script if you'd rather record on your phone.
"""

import argparse
import json
import textwrap


def build(lesson):
    lines = [
        f"RECORDING SCRIPT: {lesson['title']}",
        f"{lesson['subject']} · Grade {lesson['grade']} · language: {lesson['language']}",
        "",
        "Tips: quiet room, phone 20-30 cm from your mouth, same place every time.",
        "Pause for a second before you start and after you finish each scene.",
        "Speak at a relaxed teaching pace. The video adjusts to your speed.",
        "",
    ]
    for i, scene in enumerate(lesson["scenes"]):
        lines.append(f"--- Save as: scene_{i:02d}  ({scene['type']}: {scene.get('heading', '')})")
        lines.extend(textwrap.wrap(scene["narration"], 76))
        lines.append("")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("lesson")
    ap.add_argument("--out")
    a = ap.parse_args()
    with open(a.lesson, encoding="utf-8") as fh:
        text = build(json.load(fh))
    if a.out:
        with open(a.out, "w", encoding="utf-8") as fh:
            fh.write(text)
        print(f"saved {a.out}")
    else:
        print(text)


if __name__ == "__main__":
    main()
