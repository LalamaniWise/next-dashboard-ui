"""Compare the base model and your fine-tuned model on held-out questions.

Both models are called through OpenAI-compatible endpoints (e.g. two vLLM
servers, or one vLLM server with the base model and the LoRA adapter loaded).
The output is a CSV for a teacher to mark side by side.

    python eval.py --val data/val.jsonl --base-url http://localhost:8000/v1 \
        --base-model Qwen/Qwen2.5-7B-Instruct --tuned-model school-tutor \
        --out eval.csv
"""

import argparse
import csv
import json
import os
import urllib.request


def ask(url, model, messages):
    body = {"model": model, "messages": messages, "max_tokens": 1500, "temperature": 0.2}
    req = urllib.request.Request(
        url.rstrip("/") + "/chat/completions", data=json.dumps(body).encode(),
        headers={"content-type": "application/json",
                 "Authorization": f"Bearer {os.environ.get('TUTOR_API_KEY', '')}"})
    with urllib.request.urlopen(req, timeout=300) as resp:
        return json.loads(resp.read())["choices"][0]["message"]["content"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--val", required=True)
    ap.add_argument("--base-url", required=True)
    ap.add_argument("--tuned-url", default=None, help="defaults to --base-url")
    ap.add_argument("--base-model", required=True)
    ap.add_argument("--tuned-model", required=True)
    ap.add_argument("--out", default="eval.csv")
    a = ap.parse_args()

    with open(a.val, encoding="utf-8") as fh, open(a.out, "w", newline="", encoding="utf-8") as out:
        w = csv.writer(out)
        w.writerow(["source", "question", "memo_answer", "base_answer", "tuned_answer",
                    "better (base/tuned/same)", "tuned_correct (Y/N)"])
        for line in fh:
            ex = json.loads(line)
            prompt = ex["messages"][:-1]
            w.writerow([
                ex.get("source", ""), prompt[-1]["content"], ex["messages"][-1]["content"],
                ask(a.base_url, a.base_model, prompt),
                ask(a.tuned_url or a.base_url, a.tuned_model, prompt), "", "",
            ])
            print("done", ex.get("source", ""))
    print(f"saved {a.out}")


if __name__ == "__main__":
    main()
