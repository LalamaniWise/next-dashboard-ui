"""One lesson video: write the lesson, render it, upload it to YouTube."""

import json
import os
import secrets
import shutil
import sys

from config import SAMPLE_LESSON, VIDEO_DIR

if VIDEO_DIR not in sys.path:
    sys.path.insert(0, VIDEO_DIR)

LANGUAGE_NAMES = {"en": "English", "af": "Afrikaans"}


def write_step(job, settings) -> dict:
    if settings.writer == "sample":
        with open(SAMPLE_LESSON, encoding="utf-8") as fh:
            return json.load(fh)
    from script_writer import write_lesson
    return write_lesson(job["subject"], job["grade"], job["topic"], job["language"])


def render_step(lesson_path, out_path, job, settings) -> str:
    from render_lesson import render
    voice_model = settings.piper_voices.get(job["language"]) if job["voice"] == "piper" else None
    return render(lesson_path, out_path, tts_backend=job["voice"], quality=settings.quality,
                  voice_model=voice_model)


def youtube_text(text, limit):
    # YouTube rejects < and > in titles and descriptions
    text = " ".join(str(text).replace("<", "").replace(">", "").split())
    return text[:limit].rstrip()


def video_details(lesson, job):
    title = youtube_text(lesson.get("title") or job["topic"], 100)
    description = (
        f"Subject: {job['subject']}\n"
        f"Grade: {job['grade']}\n"
        f"Topic: {youtube_text(job['topic'], 500)}\n"
        f"Language: {LANGUAGE_NAMES.get(job['language'], job['language'])}"
    )
    return title, description


def upload_step(mp4_path, lesson, job, settings):
    """Returns (youtube url, privacy status)."""
    title, description = video_details(lesson, job)
    if settings.dry_run:
        fake_id = secrets.token_urlsafe(9)[:11]
        return f"https://www.youtube.com/watch?v={fake_id}", "dry-run"
    from youtube_upload import upload
    video_id, privacy = upload(mp4_path, title, description, job["language"], settings)
    return f"https://www.youtube.com/watch?v={video_id}", privacy


def make_runner(settings):
    def run(job, progress):
        work = os.path.join(settings.work_dir, job["id"])
        os.makedirs(work, exist_ok=True)

        lesson = write_step(job, settings)
        title, _ = video_details(lesson, job)
        lesson_path = os.path.join(work, "lesson.json")
        with open(lesson_path, "w", encoding="utf-8") as fh:
            json.dump(lesson, fh, indent=2, ensure_ascii=False)

        progress("rendering", title=title)
        mp4 = render_step(lesson_path, os.path.join(work, "lesson.mp4"), job, settings)

        progress("uploading")
        url, privacy = upload_step(mp4, lesson, job, settings)

        # Only the YouTube copy is kept. After a failure the files stay in
        # work/ so the video can be checked or uploaded by hand.
        shutil.rmtree(work, ignore_errors=True)
        return {"title": title, "youtubeUrl": url, "privacy": privacy}

    return run
