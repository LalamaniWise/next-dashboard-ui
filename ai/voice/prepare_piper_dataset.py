"""Turn recorder downloads into a Piper training dataset.

    python prepare_piper_dataset.py sentences_en-recordings.zip more-recordings.zip --out dataset_en
    python prepare_piper_dataset.py sentences_af-recordings.zip --out dataset_af

Input: zip files (or extracted folders) from recorder.html, each with audio
files and a metadata.csv ("file|text").

Output (what `python -m piper.train fit` expects):
    dataset_en/wavs/<id>.wav      22050 Hz mono, silence trimmed, even volume
    dataset_en/metadata.csv       <id>.wav|text
    dataset_en/problems.csv       clips to re-record (clipped, too quiet, too long)

Train one dataset per language: English and Afrikaans become separate voices.
"""

import argparse
import csv
import os
import subprocess
import sys
import tempfile
import wave
import zipfile

import numpy as np

SAMPLE_RATE = 22050
def open_source(path, tmp):
    if os.path.isdir(path):
        return path
    folder = os.path.join(tmp, os.path.basename(path) + "_x")
    with zipfile.ZipFile(path) as z:
        z.extractall(folder)
    return folder


def read_metadata(folder):
    with open(os.path.join(folder, "metadata.csv"), encoding="utf-8") as fh:
        for line in fh:
            if "|" in line:
                name, text = line.rstrip("\n").split("|", 1)
                yield name.strip(), text.strip()


def _decode(src, rate):
    raw = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", src, "-ac", "1",
                          "-ar", str(rate), "-f", "f32le", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).copy()


def trim_and_level(samples, rate, pad=0.12, threshold_db=-45.0, target_db=-20.0):
    """Cut silence at both ends (keeping a short pause) and level the volume.

    Done in Python rather than with ffmpeg filters, which can stall on some
    inputs (e.g. a long, constant loud sound)."""
    if samples.size == 0:
        return samples
    threshold = 10 ** (threshold_db / 20)
    loud = np.flatnonzero(np.abs(samples) > threshold)
    if loud.size == 0:
        return samples[:0]
    p = int(pad * rate)
    samples = samples[max(0, loud[0] - p): loud[-1] + p + 1]
    rms = float(np.sqrt(np.mean(samples ** 2)))
    if rms > 0:
        samples = samples * (10 ** (target_db / 20) / rms)
    peak = float(np.max(np.abs(samples)))
    if peak > 0.89:  # keep peaks below about -1 dB so nothing clips
        samples = samples * (0.89 / peak)
    return samples


def _write_wav(path, samples, rate):
    pcm = (np.clip(samples, -1, 1) * 32767).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())


def convert(src, dst):
    """Returns the original (un-levelled) samples, used to detect clipping."""
    raw = _decode(src, SAMPLE_RATE)
    _write_wav(dst, trim_and_level(raw, SAMPLE_RATE), SAMPLE_RATE)
    return raw


def check_clip(samples, wav_path):
    """Return (seconds, problem or ''). Clipping is judged on the original
    recording, before volume levelling."""
    with wave.open(wav_path) as w:
        seconds = w.getnframes() / w.getframerate()
    if samples.size == 0:
        return seconds, "empty recording"
    peak = float(np.max(np.abs(samples)))
    rms = float(np.sqrt(np.mean(samples ** 2)))
    if np.mean(np.abs(samples) > 0.99) > 0.001:
        return seconds, "clipped (too loud): move the mic further away"
    if peak < 0.03 or rms < 0.002:
        return seconds, "too quiet or silent"
    if seconds < 0.8:
        return seconds, "too short"
    if seconds > 20:
        return seconds, "too long (over 20 s): split the sentence"
    return seconds, ""


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("sources", nargs="+", help="recorder .zip files or extracted folders")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    wav_dir = os.path.join(a.out, "wavs")
    os.makedirs(wav_dir, exist_ok=True)
    rows, problems, total = [], [], 0.0
    with tempfile.TemporaryDirectory() as tmp:
        for source in a.sources:
            folder = open_source(source, tmp)
            for name, text in read_metadata(folder):
                src = os.path.join(folder, name)
                if not os.path.exists(src):
                    problems.append((name, text, "file missing"))
                    continue
                wav_name = os.path.splitext(name)[0] + ".wav"
                dst = os.path.join(wav_dir, wav_name)
                raw = convert(src, dst)
                seconds, problem = check_clip(raw, dst)
                if problem:
                    problems.append((name, text, problem))
                    os.remove(dst)
                    continue
                rows.append((wav_name, text))
                total += seconds

    with open(os.path.join(a.out, "metadata.csv"), "w", encoding="utf-8") as fh:
        fh.writelines(f"{n}|{t}\n" for n, t in rows)
    with open(os.path.join(a.out, "problems.csv"), "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["file", "text", "problem"])
        w.writerows(problems)

    print(f"{len(rows)} clips, {total / 60:.1f} minutes of speech -> {a.out}")
    if problems:
        print(f"{len(problems)} clips skipped, see {a.out}/problems.csv (re-record those lines)")
    if total < 30 * 60:
        print("Tip: aim for 30-60+ minutes for a natural-sounding voice. "
              "Use make_sentences.py to get more lines to read.", file=sys.stderr)


if __name__ == "__main__":
    main()
