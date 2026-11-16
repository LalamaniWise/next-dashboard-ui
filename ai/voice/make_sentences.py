"""Make more voice-training sentences from lessons or any text you own.

    python make_sentences.py ../video/lessons/*.json notes.txt --out sentences_more.txt

Lesson narration is split into sentences; text files are split into
sentences too. Very short or very long sentences are skipped (4-30 words
train best), as are duplicates of lines you already have.
"""

import argparse
import json
import re


def sentences_from(path):
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    if path.lower().endswith(".json"):
        lesson = json.loads(text)
        text = " ".join(s["narration"] for s in lesson.get("scenes", []))
    text = re.sub(r"\s+", " ", text)
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+(?=[A-Z0-9'\"])", text) if s.strip()]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("inputs", nargs="+")
    ap.add_argument("--out", required=True)
    ap.add_argument("--exclude", nargs="*", default=["sentences_en.txt", "sentences_af.txt"],
                    help="sentence files whose lines should not be repeated")
    a = ap.parse_args()

    seen = set()
    for path in a.exclude:
        try:
            with open(path, encoding="utf-8") as fh:
                seen.update(l.strip().lower() for l in fh if l.strip() and not l.startswith("#"))
        except FileNotFoundError:
            pass

    out = []
    for path in a.inputs:
        for s in sentences_from(path):
            words = len(s.split())
            if 4 <= words <= 30 and s.lower() not in seen:
                seen.add(s.lower())
                out.append(s.replace("|", " "))
    with open(a.out, "w", encoding="utf-8") as fh:
        fh.write(f"# {len(out)} sentences from {', '.join(a.inputs)}\n" + "\n".join(out) + "\n")
    print(f"{len(out)} sentences -> {a.out}")


if __name__ == "__main__":
    main()
