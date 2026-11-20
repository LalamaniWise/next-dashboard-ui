# Lesson-video service

Makes the AI lesson videos for the app's **Create video** page: Claude writes
the lesson, `../video/render_lesson.py` renders it, and the MP4 is uploaded to
the school's YouTube channel. The app saves the YouTube link as a Video.

```
app (Next.js server) ──X-Video-Secret──► service (127.0.0.1:8765) ──► Claude ──► Manim ──► YouTube
```

Only the Next.js server talks to the service. It listens on 127.0.0.1 only and
every request needs the shared secret, so the browser never sees either.

## Setup

1. **Rendering tools.** Python 3.11+, `ffmpeg`, `espeak-ng` and LaTeX.
   - Windows: `winget install Gyan.FFmpeg`, `winget install --scope user MiKTeX.MiKTeX`
     and the eSpeak NG installer. Turn on MiKTeX's automatic package install
     (`initexmf --set-config-value=[MPM]AutoInstall=1`) so Manim's LaTeX
     packages download the first time they are needed.
   - Ubuntu / WSL: see `../README.md`.
2. **Python packages:**
   ```bash
   pip install -r ai/video/requirements.txt -r ai/service/requirements.txt
   ```
3. **Settings.** Copy `.env.example` to `.env` in this folder and fill it in.
   Put the same `VIDEO_SERVICE_SECRET`, plus `VIDEO_SERVICE_URL=http://127.0.0.1:8765`,
   in the app's `.env`.

## What a video job makes

On **Create video**, type what the lesson should explain, attach a PDF or a picture
(up to 10 MB) for it to teach from, or do both. Each job makes the video plus
an activity PDF and a memo PDF, typeset with LaTeX. Admins and teachers download them
from the Videos page; the service keeps the files of the last 30 jobs. In a dry run
the video is kept to download too.

## Voices

- **Computer voice:** espeak, nothing to set up.
- **Cori and Northern English man:** ready-made English Piper voices. Run
  `python ai/voice/get_voices.py` once to download them (about 63 MB each). Their
  licences require credit, so it is added to each video's YouTube description.
- **Your trained voice:** set `PIPER_VOICE_EN` or `PIPER_VOICE_AF` (see `../voice/README.md`).

## Test it without Claude or YouTube

In `ai/service/.env`:

```
WRITER=sample      # always renders the sample lesson, no API key needed
DRY_RUN=1          # skips YouTube and returns a fake link
RENDER_QUALITY=l   # fastest render
```

Then run `python ai/service/app.py`, start the app, and use **Create video**.
The video is rendered for real, but the saved YouTube link points nowhere.

## Going live

1. **Claude:** set `ANTHROPIC_API_KEY` and `WRITER=anthropic`.
2. **YouTube:**
   1. In Google Cloud, create a project, enable the *YouTube Data API v3*, and
      create an OAuth client ID of type *Desktop app*.
   2. Put its ID and secret in `YOUTUBE_CLIENT_ID` and `YOUTUBE_CLIENT_SECRET`.
   3. Run `python ai/service/youtube_auth.py` and sign in with the account that
      owns the school's channel. Add the `YOUTUBE_REFRESH_TOKEN` line it prints.
   4. Until the Google Cloud project passes YouTube's API audit, YouTube makes
      every uploaded video private, whatever `YOUTUBE_PRIVACY` says.
3. Set `DRY_RUN=0` and restart the service.

The service checks the settings when a video is requested, so a missing key is
reported straight away on the Create video page rather than after rendering.

## How jobs run

- One video renders at a time; up to 20 more wait in the queue.
- Job status is saved in `jobs.json`, so a restart keeps the history. A job
  that was mid-render when the service stopped is marked failed.
- Each job's files are in `work/<job id>/` while it runs. They are deleted
  after a successful upload and kept after a failure so you can check them.

## Tests

```bash
cd ai/service
python -m pytest -q
```
