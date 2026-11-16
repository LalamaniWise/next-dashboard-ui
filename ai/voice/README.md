# Your voice in the lesson videos

Two ways, and you can do both:

| | Option 1: Record each lesson | Option 2: Train a voice model |
|---|---|---|
| Sounds like | Exactly you | Close to you (improves with more recordings) |
| Work per new lesson | Record it (2-3 min) | None. Any lesson is read automatically |
| Setup | None | Record 30-60+ min of sentences once, train on a free GPU |

Only use your own voice, or someone who has agreed in writing. It's good practice
to tell students when narration is AI-generated in your voice.

## The recorder page (used for both)

The page needs to run on `localhost` so the browser lets it use the microphone:

```bash
cd ai/voice
python -m http.server 8000
```

Open http://localhost:8000/recorder.html, then open a lesson `.json` (option 1) or a
`sentences_*.txt` file (option 2).

- **Space** to start/stop, **Enter** for the next line, **P** to play back.
- Recordings are kept in your browser, so you can stop and continue another day.
- **Download all (.zip)** gives you the audio files plus `metadata.csv`.

Tips: a quiet room (curtains, cupboards and carpets help), the same mic and place
every time, about 20-30 cm from your mouth, and a natural teaching pace. Re-record
any line you stumble on.

## Option 1: Record each lesson

1. Open the lesson `.json` in the recorder and record every scene.
2. Unzip the download into a folder, e.g. `recordings/stationary-points/`.
3. Render:
   ```bash
   cd ai/video
   python render_lesson.py lessons/gr12-maths-stationary-points.json \
       --tts recorded --voice-dir ../voice/recordings/stationary-points
   ```

Prefer your phone's voice-memo app? Run `python recording_script.py lesson.json` to
print what to read, and name the files `scene_00`, `scene_01`, ... (any format:
m4a, mp3, wav, webm). Silence at the start and end is trimmed and the volume is
levelled automatically, and the animation stretches to match your pace.

## Option 2: Train a voice model of your voice

1. **Record** `sentences_en.txt` (and `sentences_af.txt` for an Afrikaans voice).
   Together they are about 10 and 5 minutes. For a natural result aim for 30-60+
   minutes, so make more lines from your lessons or notes:
   ```bash
   python make_sentences.py ../video/lessons/*.json my_notes.txt --out sentences_more.txt
   ```
   Have an Afrikaans teacher check `sentences_af.txt` before you record it.
2. **Prepare** the dataset (one per language):
   ```bash
   pip install numpy
   python prepare_piper_dataset.py sentences_en-recordings.zip sentences_more-recordings.zip --out dataset_en
   ```
   Clips that are clipped, silent or too long are listed in `dataset_en/problems.csv`.
   Re-record those lines and run it again. Then zip the `dataset_en` folder.
3. **Train** on a free Google Colab GPU: open `train_voice_colab.ipynb` in Colab, choose a
   T4 GPU, and run the cells. Progress is saved to your Google Drive.
4. **Use it**:
   ```bash
   pip install piper-tts
   python render_lesson.py lesson.json --tts piper --voice-model my_voice_en.onnx
   ```
   Keep `my_voice_en.onnx.json` next to the `.onnx` file.

## What has been tested
- Recorder page: recording with the keyboard, keeping recordings after a reload, and the
  zip download (headless Chrome with a simulated microphone).
- `--tts recorded`: phone-style `.m4a` and browser `.webm` recordings, with silence trimmed
  and volume levelled.
- `prepare_piper_dataset.py`: catches clipped, silent and missing clips.
- **Not yet run:** the Colab training notebook and `--tts piper`. Both follow Piper's
  current documentation (piper1-gpl), but they need a GPU and downloads that weren't
  available here. If a training option is rejected, run `python -m piper.train fit --help`.
