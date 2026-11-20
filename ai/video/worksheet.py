"""Activity and memo PDFs for a lesson, typeset with pdflatex.

An activity is JSON written by the script writer:

  {"title": str, "instructions": str,
   "questions": [{"text": str, "marks": int, "answer": [str]}]}

title and instructions are plain text. text and each answer line are LaTeX
text with inline maths in $...$, the same as lesson bullets.
"""

import os
import re
import shutil
import subprocess
import tempfile

from lesson_schema import LessonError, clean_bullet

BRAND = "CMS Extra Classes"
MIN_QUESTIONS, MAX_QUESTIONS = 3, 20
MAX_MARKS = 30
# Room to write an answer, per mark and at most per question
CM_PER_MARK, MAX_ANSWER_CM = 0.9, 6.0

LABELS = {
    "en": {"activity": "Activity", "memo": "Memorandum", "name": "Name", "date": "Date",
           "grade": "Grade", "total": "Total", "marks": "marks", "instructions": "Instructions"},
    "af": {"activity": "Aktiwiteit", "memo": "Memorandum", "name": "Naam", "date": "Datum",
           "grade": "Graad", "total": "Totaal", "marks": "punte", "instructions": "Instruksies"},
}

SAMPLE_ACTIVITY = {
    "title": "Practice activity",
    "instructions": "Answer all the questions and show your working.",
    "questions": [
        {"text": "Calculate $2 + 3$.", "marks": 1, "answer": ["$2 + 3 = 5$"]},
        {"text": "Calculate $4 \\times 5$.", "marks": 1, "answer": ["$4 \\times 5 = 20$"]},
        {"text": "Solve $x + 1 = 3$.", "marks": 2, "answer": ["$x = 3 - 1$", "$x = 2$"]},
    ],
}

PLAIN_TEXT = {"\\": r"\textbackslash{}", "{": r"\{", "}": r"\}", "$": r"\$", "&": r"\&", "%": r"\%",
              "#": r"\#", "_": r"\_", "^": r"\^{}", "~": r"\~{}"}


def plain(text) -> str:
    """Text shown exactly as written, whatever characters it contains."""
    text = re.sub(r"[^\x20-\x7eÀ-ÿ‘’“”–—…]", " ", " ".join(str(text).split()))
    return "".join(PLAIN_TEXT.get(ch, ch) for ch in text)


def validate_activity(activity: dict) -> dict:
    for key in ("title", "instructions"):
        if not isinstance(activity.get(key), str) or not activity[key].strip():
            raise LessonError(f"activity is missing '{key}'")
    questions = activity.get("questions")
    if not isinstance(questions, list) or not MIN_QUESTIONS <= len(questions) <= MAX_QUESTIONS:
        raise LessonError(f"activity needs {MIN_QUESTIONS} to {MAX_QUESTIONS} questions")
    for number, q in enumerate(questions, 1):
        marks = q.get("marks")
        if not isinstance(marks, int) or isinstance(marks, bool) or not 1 <= marks <= MAX_MARKS:
            raise LessonError(f"question {number}: marks must be a whole number from 1 to {MAX_MARKS}")
        answer = q.get("answer")
        if not isinstance(q.get("text"), str) or not q["text"].strip():
            raise LessonError(f"question {number}: missing text")
        if not isinstance(answer, list) or not answer or not all(isinstance(a, str) and a.strip() for a in answer):
            raise LessonError(f"question {number}: answer must be a list of lines")
        try:
            clean_bullet(q["text"])
            for line in answer:
                clean_bullet(line)
        except LessonError as err:
            raise LessonError(f"question {number}: {err}") from err
    return activity


def tex_document(activity: dict, details: dict, memo: bool) -> str:
    words = LABELS[details["language"]]
    total = sum(q["marks"] for q in activity["questions"])
    kind = words["memo" if memo else "activity"]
    lines = [
        r"\documentclass[11pt,a4paper]{article}",
        r"\usepackage[T1]{fontenc}",
        r"\usepackage{lmodern}",
        r"\usepackage[margin=2cm]{geometry}",
        r"\usepackage{amsmath,amssymb}",
        r"\usepackage{graphicx}",
        r"\setlength{\parindent}{0pt}",
        r"\begin{document}",
        r"\begin{center}",
    ]
    if details.get("logo"):
        # compile_pdf copies the logo next to the .tex file as logo.png/.jpg
        lines.append(rf"\includegraphics[height=2.2cm]{{logo{os.path.splitext(details['logo'])[1].lower()}}}\\[4pt]")
    lines += [
        rf"{{\Large\bfseries {plain(BRAND)}}}\\[4pt]",
        rf"{{\large\bfseries {plain(activity['title'])}: {plain(kind)}}}\\[2pt]",
        rf"{plain(details['subject'])} \textbullet{{}} {words['grade']} {int(details['grade'])}",
        r"\end{center}",
    ]
    if not memo:
        lines.append(rf"{words['name']}: \rule{{7.5cm}}{{0.4pt}} \hfill "
                     rf"{words['date']}: \rule{{3.5cm}}{{0.4pt}}\par\medskip")
        lines.append(rf"\textbf{{{words['instructions']}:}} {plain(activity['instructions'])}\par")
    lines.append(rf"\medskip\textbf{{{words['total']}: {total} {words['marks']}}}\par\medskip")
    lines.append(r"\begin{enumerate}")
    for q in activity["questions"]:
        lines.append(rf"\item {clean_bullet(q['text'])} \hfill \textbf{{({q['marks']})}}")
        if memo:
            lines.append(r"\begin{itemize}")
            lines += [rf"\item {clean_bullet(line)}" for line in q["answer"]]
            lines.append(r"\end{itemize}")
        else:
            lines.append(rf"\par\vspace{{{min(q['marks'] * CM_PER_MARK, MAX_ANSWER_CM):.1f}cm}}")
    lines += [r"\end{enumerate}", r"\end{document}", ""]
    return "\n".join(lines)


def compile_pdf(tex: str, out_path: str, logo: str = None) -> None:
    with tempfile.TemporaryDirectory(prefix="worksheet_") as work:
        with open(os.path.join(work, "sheet.tex"), "w", encoding="utf-8") as fh:
            fh.write(tex)
        if logo:
            shutil.copy(logo, os.path.join(work, "logo" + os.path.splitext(logo)[1].lower()))
        # paranoid: TeX may only read and write inside this folder
        env = {**os.environ, "openin_any": "p", "openout_any": "p"}
        done = subprocess.run(
            ["pdflatex", "-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error", "sheet.tex"],
            cwd=work, env=env, capture_output=True, timeout=300,
        )
        pdf = os.path.join(work, "sheet.pdf")
        if done.returncode or not os.path.exists(pdf):
            log = done.stdout.decode("utf-8", "replace")
            problem = next((line[2:] for line in log.splitlines() if line.startswith("! ")), "unknown error")
            raise LessonError(f"the worksheet would not typeset: {problem}")
        shutil.copy(pdf, out_path)


def make_pdfs(activity: dict, details: dict, out_dir: str) -> None:
    """Write activity.pdf and memo.pdf into out_dir."""
    os.makedirs(out_dir, exist_ok=True)
    logo = details.get("logo")
    if logo and (not os.path.exists(logo) or os.path.splitext(logo)[1].lower() not in (".png", ".jpg", ".jpeg")):
        details = {**details, "logo": None}  # pdflatex can only place PNG and JPG
        logo = None
    compile_pdf(tex_document(activity, details, memo=False), os.path.join(out_dir, "activity.pdf"), logo)
    compile_pdf(tex_document(activity, details, memo=True), os.path.join(out_dir, "memo.pdf"), logo)
