# School AI: tutor model + lesson videos

Two parts, built to work together:

| Part | Folder | What it does |
|---|---|---|
| Lesson videos | `video/` | Turns a lesson (JSON) into a narrated MP4 with animated equations and graphs |
| Tutor model | `finetune/` | Fine-tunes an open model on CAPS past papers + memos so it explains like a South African teacher |
| Your voice | `voice/` | Record lessons in your own voice, or train a voice model of your voice (see `voice/README.md`) |

```
topic ──► script_writer.py ──► lesson.json ──► render_lesson.py ──► lesson.mp4
            (Claude now, your                    (Manim + voice)
             fine-tuned model later)
```

## 1. Lesson videos (`video/`)

Setup (Ubuntu / WSL):

```bash
sudo apt install ffmpeg espeak-ng libpango1.0-dev texlive-latex-extra dvisvgm
pip install -r video/requirements.txt
```

Render the sample lesson:

```bash
cd video
python render_lesson.py lessons/gr12-maths-stationary-points.json --out stationary-points.mp4
```

Write a new lesson with AI, then render it:

```bash
export ANTHROPIC_API_KEY=...
python script_writer.py --subject "Physical Sciences" --grade 11 \
    --topic "Newton's second law" --out lessons/newton2.json
python render_lesson.py lessons/newton2.json
```

- **Look:** a stick-man teacher stands at the board and points a laser at each line as it is
  written, and circles the answer.
  Every video opens and closes with the CMS Extra Classes messages (`BRAND` in
  `video/render_lesson.py`), except with `--tts recorded`. `--board white` (default) is a whiteboard, `--board black` a chalkboard.
  Lessons are written for learners starting from zero and run about 4 to 6 minutes.
- **Your own voice:** `--tts recorded --voice-dir <folder>` uses your recordings, and
  `--tts piper --voice-model my_voice.onnx` uses a voice model trained on your voice.
  See `voice/README.md`.
- **Other voices:** `--tts espeak` is free and offline but robotic. `--tts azure` uses Azure AI
  Speech neural voices: South African English (`en-ZA`) and Afrikaans (`af-ZA`). Set
  `AZURE_SPEECH_KEY` and `AZURE_SPEECH_REGION`.
- **Languages:** `"language": "en"` or `"af"` in the lesson file.
- **Accuracy:** equations are typeset with LaTeX, not drawn by an image model, and every
  point marked on a graph is checked against the function before rendering. A lesson
  with a wrong turning point is rejected and the AI is asked to fix it.
- **Scene types:** `title`, `bullets`, `steps` (working revealed line by line), `graph`.
  See `lesson_schema.py`. More types (tables for Accounting, diagrams for Physics,
  maps for Geography) can be added the same way.

## 2. Tutor model (`finetune/`)

Fine-tuning = taking a free open model and training it further on your own data.
It runs on one GPU, which costs far less than training a model from scratch.

1. **Collect data.** Download past papers and memos (DBE publishes NSC papers
   on education.gov.za; check their terms of use) into
   `finetune/data/raw/<Subject>/<name>-QP.pdf` and `<name>-MEMO.pdf`.
   Several years per subject, English and Afrikaans versions.
2. **Prepare it.**
   ```bash
   cd finetune
   pip install -r requirements.txt
   python prepare_data.py --raw data/raw --out data --grade 12 --teacher anthropic
   ```
   `--teacher anthropic` has Claude rewrite each memo answer as a step-by-step
   explanation. **Have a teacher check a sample of `data/review.csv`**: the model
   learns whatever is in this data, mistakes included.
3. **Train on Azure ML** (one A100 GPU; it switches off when idle):
   ```bash
   az ml compute create -n gpu-a100 --type AmlCompute \
       --size Standard_NC24ads_A100_v4 --min-instances 0 --max-instances 1
   az ml job create -f azureml/train-job.yml
   ```
4. **Serve it** with vLLM (gives an OpenAI-compatible API):
   ```bash
   vllm serve Qwen/Qwen2.5-7B-Instruct --enable-lora \
       --lora-modules school-tutor=outputs/school-tutor
   ```
5. **Check it is actually better.** `eval.py` puts base vs fine-tuned answers side by
   side in a CSV for a teacher to mark. Only switch over if the tuned model wins.
6. **Use it for videos.**
   `script_writer.py --backend openai --model school-tutor` (set `TUTOR_API_BASE`).

### Tested so far
- Video pipeline: rendered the sample lesson (English) and an Afrikaans test.
- Data prep: split and paired a sample paper and memo into train and validation files.
- Training: ran `train_qlora.py` end to end on a tiny local model (CPU, `--no-4bit`) and
  confirmed it saves an adapter. Not yet run on a real model or GPU.

### Still to do
- Real past papers for each subject (the biggest job)
- Tables (Accounting), diagrams (Physical Sciences, Life Sciences) and maps (Geography)
  in the video renderer
- A tutor chat page and a "make a video" button in the dashboard
- EGD: theory only. Neither part can produce or mark precise technical drawings.
