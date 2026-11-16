"""Turn CAPS past papers + memos into training data for the tutor model.

Folder layout (one folder per subject, file names must pair up):

    data/raw/Mathematics/2023-Nov-P1-QP.pdf     question paper
    data/raw/Mathematics/2023-Nov-P1-MEMO.pdf   matching memorandum
    data/raw/Physical Sciences/2022-Jun-P2-QP.pdf ...

Steps
  1. Extract text from each PDF (or .txt).
  2. Split paper and memo by "QUESTION n" / "VRAAG n" and pair them up.
  3. --teacher anthropic: a strong model rewrites each memo answer as a clear,
     step-by-step explanation a learner can follow (this is "distillation").
     --teacher none: keep the memo text as the answer (fast, no API cost).
  4. Write chat-format JSONL, split into train / validation sets.

    python prepare_data.py --raw data/raw --out data --grade 12 --teacher anthropic

Have a teacher spot-check a sample of data/review.csv before training: the
model will learn whatever is in these files, mistakes included.
"""

import argparse
import csv
import json
import os
import random
import re
import sys
import urllib.request

SYSTEM = ("You are a patient tutor for South African learners, following the CAPS "
          "curriculum. Explain step by step, show all working the way the memo "
          "expects, and use South African conventions.")

QUESTION_RE = re.compile(r"^\s*(?:QUESTION|VRAAG)\s+(\d{1,2})\b", re.I | re.M)


def read_text(path):
    if path.lower().endswith(".txt"):
        with open(path, encoding="utf-8", errors="ignore") as fh:
            return fh.read()
    from pypdf import PdfReader
    return "\n".join(page.extract_text() or "" for page in PdfReader(path).pages)


def split_questions(text):
    """Return {question_number: text} for a paper or memo."""
    parts = {}
    matches = list(QUESTION_RE.finditer(text))
    for i, m in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        body = text[m.start():end].strip()
        num = int(m.group(1))
        # Keep the longest block if a number repeats (e.g. in a header/contents page).
        if len(body) > len(parts.get(num, "")):
            parts[num] = body
    return parts


def find_pairs(raw_dir):
    """Yield (subject, paper_name, qp_path, memo_path)."""
    for subject in sorted(os.listdir(raw_dir)):
        sdir = os.path.join(raw_dir, subject)
        if not os.path.isdir(sdir):
            continue
        files = os.listdir(sdir)
        for f in sorted(files):
            m = re.match(r"(.+)-QP\.(pdf|txt)$", f, re.I)
            if not m:
                continue
            memo = next((g for g in files if re.match(re.escape(m.group(1)) + r"-MEMO\.(pdf|txt)$", g, re.I)), None)
            if memo:
                yield subject, m.group(1), os.path.join(sdir, f), os.path.join(sdir, memo)
            else:
                print(f"no memo for {subject}/{f}, skipped", file=sys.stderr)


def teacher_explain(subject, grade, question, memo):
    prompt = (
        f"Subject: {subject}, Grade {grade}.\n\nEXAM QUESTION:\n{question}\n\n"
        f"OFFICIAL MEMO:\n{memo}\n\n"
        "Write the ideal tutor answer to this question for a learner. Follow the memo's "
        "method and final answers exactly, explain each step briefly, show working, and "
        "mention where marks are earned. Do not mention the memo."
    )
    body = {"model": os.environ.get("TEACHER_MODEL", "claude-sonnet-5-5"), "max_tokens": 3000,
            "system": SYSTEM, "messages": [{"role": "user", "content": prompt}]}
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages", data=json.dumps(body).encode(),
        headers={"x-api-key": os.environ["ANTHROPIC_API_KEY"],
                 "anthropic-version": "2023-06-01", "content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as resp:
        data = json.loads(resp.read())
    return "".join(b.get("text", "") for b in data["content"]).strip()


def build_examples(raw_dir, grade, teacher):
    examples = []
    for subject, paper, qp, memo in find_pairs(raw_dir):
        questions, answers = split_questions(read_text(qp)), split_questions(read_text(memo))
        common = sorted(set(questions) & set(answers))
        print(f"{subject}/{paper}: {len(common)} questions paired")
        for n in common:
            answer = answers[n] if teacher == "none" else teacher_explain(subject, grade, questions[n], answers[n])
            examples.append({
                "source": f"{subject}/{paper}/Q{n}",
                "messages": [
                    {"role": "system", "content": SYSTEM},
                    {"role": "user", "content": f"[{subject} · Grade {grade}]\n{questions[n]}"},
                    {"role": "assistant", "content": answer},
                ],
            })
    return examples


def write_outputs(examples, out_dir, val_fraction, seed=42):
    os.makedirs(out_dir, exist_ok=True)
    random.Random(seed).shuffle(examples)
    n_val = max(1, int(len(examples) * val_fraction)) if len(examples) > 1 else 0
    splits = {"val.jsonl": examples[:n_val], "train.jsonl": examples[n_val:]}
    for name, rows in splits.items():
        with open(os.path.join(out_dir, name), "w", encoding="utf-8") as fh:
            for r in rows:
                fh.write(json.dumps(r, ensure_ascii=False) + "\n")
    with open(os.path.join(out_dir, "review.csv"), "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["source", "question", "answer", "teacher_ok (Y/N)", "notes"])
        for r in examples:
            w.writerow([r["source"], r["messages"][1]["content"], r["messages"][2]["content"], "", ""])
    print(f"train: {len(splits['train.jsonl'])}  val: {len(splits['val.jsonl'])}  -> {out_dir}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--raw", default="data/raw")
    ap.add_argument("--out", default="data")
    ap.add_argument("--grade", type=int, default=12)
    ap.add_argument("--teacher", choices=["anthropic", "none"], default="none")
    ap.add_argument("--val-fraction", type=float, default=0.1)
    a = ap.parse_args()
    write_outputs(build_examples(a.raw, a.grade, a.teacher), a.out, a.val_fraction)


if __name__ == "__main__":
    main()
