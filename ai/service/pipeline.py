"""One lesson video: write the lesson, its activity and memo, render it, and
upload it to YouTube."""

import json
import os
import secrets
import shutil
import sys

from config import JOB_FILES, KEEP_OUTPUTS, PIPER_LIBRARY, SAMPLE_LESSON, VIDEO_DIR, library_model
from sources import load_source, remove_source

if VIDEO_DIR not in sys.path:
    sys.path.insert(0, VIDEO_DIR)

LANGUAGE_NAMES = {"en": "English", "af": "Afrikaans"}


def write_step(job, settings, source=None) -> dict:
    if settings.writer == "sample":
        with open(SAMPLE_LESSON, encoding="utf-8") as fh:
            return json.load(fh)
    from script_writer import write_lesson
    return write_lesson(job["subject"], job["grade"], job["topic"], job["language"], source=source,
                        cover_topic=job.get("coverTopic"), subtopic=job.get("subtopic"))


def documents_step(job, lesson, source, out_dir, settings):
    """Writes activity.pdf and memo.pdf. A worksheet that won't typeset goes back
    to the writer to fix."""
    from worksheet import SAMPLE_ACTIVITY, make_pdfs, validate_activity
    from cover import DEFAULT_LOGO
    details = {k: job[k] for k in ("subject", "grade", "language")}
    details["logo"] = settings.logo_path or DEFAULT_LOGO
    if settings.writer == "sample":
        make_pdfs(validate_activity(SAMPLE_ACTIVITY), details, out_dir)
        return
    from script_writer import write_activity
    write_activity(job["subject"], job["grade"], job["topic"], job["language"], lesson, source=source,
                   check=lambda activity: make_pdfs(activity, details, out_dir))


def render_step(lesson_path, out_path, job, settings) -> str:
    from render_lesson import render
    backend = job["voice"]
    voice_model = settings.piper_voices.get(job["language"]) if backend == "piper" else None
    if backend in PIPER_LIBRARY:
        backend, voice_model = "piper", library_model(backend)
    # Jobs saved before boards were added have no board: use the whiteboard
    return render(lesson_path, out_path, tts_backend=backend, quality=settings.quality,
                  voice_model=voice_model, board=job.get("board", "white"))


def cover_details(lesson, job):
    """What the cover shows. The teacher's own topic and subtopic win; then
    the AI's; a long request is cut down as a last resort."""
    topic = job.get("coverTopic") or lesson.get("topic") or " ".join(job["topic"].split()[:8])
    subtopic = job.get("subtopic") or lesson.get("subtopic") or None
    return {"subject": job["subject"], "grades": [job["grade"]], "topic": topic[:80],
            "subtopic": subtopic[:120] if subtopic else None, "language": job["language"]}


def cover_step(mp4_path, lesson, job, outputs, settings):
    """Draws the cover (kept for download and the YouTube thumbnail) and puts it
    at the start of the video. Returns (video path, cover path, details)."""
    from cover import make_cover, prepend_cover
    details = cover_details(lesson, job)
    cover = make_cover(details, os.path.join(outputs, JOB_FILES["cover"][0]),
                       logo_path=settings.logo_path or None, school=settings.school_name)
    with_cover = os.path.splitext(mp4_path)[0] + "-cover.mp4"
    prepend_cover(mp4_path, cover, with_cover)
    return with_cover, cover, details


def thumbnail_step(video_id, cover, settings):
    """Custom thumbnails need a phone-verified YouTube channel. Without one
    YouTube refuses, and the video simply keeps YouTube's own thumbnail."""
    if settings.dry_run:
        return "dry-run"
    from youtube_upload import set_thumbnail
    try:
        set_thumbnail(video_id, cover, settings)
        return "set"
    except Exception as err:  # never lose a finished video over its thumbnail
        print(f"thumbnail not set: {err}", file=sys.stderr)
        return "not-allowed" if "forbidden" in str(err).lower() or "403" in str(err) else "failed"


def youtube_text(text, limit):
    # YouTube rejects < and > in titles and descriptions
    text = " ".join(str(text).replace("<", "").replace(">", "").split())
    return text[:limit].rstrip()


def video_details(lesson, job):
    title = youtube_text(lesson.get("title") or job["topic"], 100)
    description = (
        f"Title: {title}\n"
        f"Subject: {job['subject']}\n"
        f"Grade: {job['grade']}\n"
        f"Topic: {youtube_text(job['topic'], 500)}\n"
        f"Language: {LANGUAGE_NAMES.get(job['language'], job['language'])}"
    )
    if job["voice"] in PIPER_LIBRARY:
        description += "\n\n" + PIPER_LIBRARY[job["voice"]]["credit"]
    return title, description


def upload_step(mp4_path, lesson, job, settings):
    """Returns (video id, youtube url, privacy status)."""
    title, description = video_details(lesson, job)
    if settings.dry_run:
        fake_id = secrets.token_urlsafe(9)[:11]
        return fake_id, f"https://www.youtube.com/watch?v={fake_id}", "dry-run"
    from youtube_upload import upload
    video_id, privacy = upload(mp4_path, title, description, job["language"], settings)
    return video_id, f"https://www.youtube.com/watch?v={video_id}", privacy


def prune_outputs(settings):
    folders = [e for e in os.scandir(settings.outputs_dir) if e.is_dir()]
    folders.sort(key=lambda e: e.stat().st_mtime, reverse=True)
    for old in folders[KEEP_OUTPUTS:]:
        shutil.rmtree(old.path, ignore_errors=True)


def make_runner(settings):
    def run(job, progress):
        work = os.path.join(settings.work_dir, job["id"])
        outputs = os.path.join(settings.outputs_dir, job["id"])
        os.makedirs(work, exist_ok=True)
        os.makedirs(outputs, exist_ok=True)

        try:
            source = load_source(job.get("source"))
            lesson = write_step(job, settings, source)
            title, _ = video_details(lesson, job)
            lesson_path = os.path.join(work, "lesson.json")
            with open(lesson_path, "w", encoding="utf-8") as fh:
                json.dump(lesson, fh, indent=2, ensure_ascii=False)

            # Before rendering, so a problem shows up in seconds, not minutes
            progress("documents", title=title)
            documents_step(job, lesson, source, outputs, settings)

            progress("rendering")
            mp4 = render_step(lesson_path, os.path.join(work, "lesson.mp4"), job, settings)
            mp4, cover, details = cover_step(mp4, lesson, job, outputs, settings)

            progress("uploading")
            video_id, url, privacy = upload_step(mp4, lesson, job, settings)
            thumbnail = thumbnail_step(video_id, cover, settings)
        finally:
            remove_source(job.get("source"))

        # With YouTube only its copy of the video is kept; a dry run keeps the
        # file to download. After a failure the files stay in work/ so the
        # video can be checked or uploaded by hand.
        files = ["activity", "memo", "cover"]
        if settings.dry_run:
            shutil.move(mp4, os.path.join(outputs, JOB_FILES["video"][0]))
            files.insert(0, "video")
        shutil.rmtree(work, ignore_errors=True)
        prune_outputs(settings)
        return {"title": title, "youtubeUrl": url, "privacy": privacy, "files": files,
                "lessonTopic": details["topic"], "subtopic": details["subtopic"], "thumbnail": thumbnail}

    return run
