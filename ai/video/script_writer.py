"""Ask an AI model to write a lesson in the format render_lesson.py reads.

    export ANTHROPIC_API_KEY=...
    python script_writer.py --subject "Mathematics" --grade 12 \
        --topic "Stationary points of a cubic" --out lessons/new.json

    # Your own fine-tuned model (any OpenAI-compatible endpoint, e.g. vLLM
    # or an Azure ML online endpoint):
    export TUTOR_API_BASE=https://<endpoint>/v1 TUTOR_API_KEY=...
    python script_writer.py --backend openai --model school-tutor ...

The lesson is validated (including checking graph points against the curve)
before it is saved. If the check fails, the model is asked to fix it.
"""

import argparse
import json
import os
import re
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lesson_schema import LessonError, validate_lesson  # noqa: E402

SYSTEM_PROMPT = """You write short video lessons for South African high-school learners,
aligned to the CAPS curriculum. Output ONLY one JSON object, no other text.

Rules
- Match the CAPS content and exam style for the given subject and grade.
- 5 to 8 scenes, about 2 to 3 minutes of narration in total.
- Start with a "title" scene and end with an "Exam tips" "bullets" scene.
- Use South African conventions: coordinates with a semicolon (3; -2), rands (R),
  decimal comma is NOT needed in maths working.
- Work every example fully and check your arithmetic. Every graph point must lie
  exactly on the curve.
- "narration" is read aloud: write maths in words ("x squared minus four"),
  never symbols or LaTeX. Keep each scene's narration under 70 words.
- Language "af" means the whole lesson (headings, bullets, narration) is in Afrikaans.

JSON format
{
  "title": str, "subject": str, "grade": int, "topic": str, "language": "en" | "af",
  "scenes": [
    {"type": "title", "heading": str, "subheading": str, "narration": str},
    {"type": "bullets", "heading": str, "bullets": [str], "narration": str},
        // bullets are LaTeX text mode; inline maths inside $...$
    {"type": "steps", "heading": str, "lines": [str], "narration": str},
        // each line is LaTeX maths (no $), revealed one at a time; last line = result
    {"type": "graph", "heading": str, "function": str, "label": str,
     "x_range": [min, max, step], "y_range": [min, max, step],
     "points": [{"x": num, "y": num, "label": str}], "narration": str}
        // function in Python syntax using only x, numbers, + - * / ** ( ),
        // sin cos tan sqrt exp log; label and point labels are LaTeX maths
  ]
}"""


def _post(url, headers, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers)
    with urllib.request.urlopen(req, timeout=300) as resp:
        return json.loads(resp.read())


def call_model(messages, backend, model):
    if backend == "anthropic":
        # Claude thinks before it writes, and the thinking counts towards
        # max_tokens, so leave plenty of room. Only tokens used are billed.
        data = _post(
            "https://api.anthropic.com/v1/messages",
            {"x-api-key": os.environ["ANTHROPIC_API_KEY"],
             "anthropic-version": "2023-06-01", "content-type": "application/json"},
            {"model": model, "max_tokens": 16000, "system": SYSTEM_PROMPT, "messages": messages},
        )
        # Asking again would hit the same wall, so stop instead of retrying
        if data.get("stop_reason") == "max_tokens":
            raise LessonError("the lesson was too long and got cut off; try a narrower topic")
        if data.get("stop_reason") == "refusal":
            raise LessonError("Claude declined to write this lesson; try rewording the topic")
        return "".join(b.get("text", "") for b in data["content"])
    # OpenAI-compatible: your fine-tuned model served by vLLM / Azure ML, or Azure OpenAI
    base = os.environ["TUTOR_API_BASE"].rstrip("/")
    data = _post(
        f"{base}/chat/completions",
        {"Authorization": f"Bearer {os.environ.get('TUTOR_API_KEY', '')}",
         "api-key": os.environ.get("TUTOR_API_KEY", ""), "content-type": "application/json"},
        {"model": model, "max_tokens": 4000, "temperature": 0.3,
         "messages": [{"role": "system", "content": SYSTEM_PROMPT}] + messages},
    )
    return data["choices"][0]["message"]["content"]


def extract_json(text):
    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        raise LessonError("model did not return JSON")
    return json.loads(match.group(0))


def write_lesson(subject, grade, topic, language="en", backend="anthropic",
                 model=None, attempts=3):
    model = model or os.environ.get("TUTOR_MODEL", "claude-sonnet-5-5")
    messages = [{"role": "user", "content":
                 f"Subject: {subject}\nGrade: {grade}\nTopic: {topic}\nLanguage: {language}"}]
    for attempt in range(1, attempts + 1):
        reply = call_model(messages, backend, model)
        try:
            return validate_lesson(extract_json(reply))
        except (LessonError, json.JSONDecodeError) as err:
            print(f"attempt {attempt}: {err}", file=sys.stderr)
            messages += [
                {"role": "assistant", "content": reply},
                {"role": "user", "content": f"That lesson has a problem: {err}. "
                                            "Fix it and return the full corrected JSON."},
            ]
    raise LessonError(f"no valid lesson after {attempts} attempts")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--subject", required=True)
    ap.add_argument("--grade", type=int, required=True)
    ap.add_argument("--topic", required=True)
    ap.add_argument("--language", choices=["en", "af"], default="en")
    ap.add_argument("--backend", choices=["anthropic", "openai"], default="anthropic")
    ap.add_argument("--model", default=None)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    lesson = write_lesson(a.subject, a.grade, a.topic, a.language, a.backend, a.model)
    with open(a.out, "w", encoding="utf-8") as fh:
        json.dump(lesson, fh, indent=2, ensure_ascii=False)
    print(f"saved {a.out}")


if __name__ == "__main__":
    main()
