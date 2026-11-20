"""Service tests. The AI writer, the renderer and YouTube are all mocked.

    cd ai/service
    python -m pytest
"""

import base64
import io
import json
import os
import shutil
import sys
import threading
import time
from types import SimpleNamespace

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import config  # noqa: E402
import pipeline  # noqa: E402
import lesson_schema  # noqa: E402
import script_writer  # noqa: E402
import sources  # noqa: E402
import worksheet  # noqa: E402
import youtube_upload  # noqa: E402
from app import create_app  # noqa: E402
from config import Settings  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from jobs import JobStore  # noqa: E402

SECRET = "test-secret-0123456789"
AUTH = {"X-Video-Secret": SECRET}
BODY = {"subject": "Mathematics", "grade": 12, "topic": "Stationary points",
        "language": "en", "voice": "espeak"}
LESSON = {"title": "Stationary points <of a cubic>", "subject": "Mathematics", "grade": 12,
          "language": "en", "scenes": []}


def make_settings(tmp_path, **overrides):
    values = dict(secret=SECRET, work_dir=str(tmp_path / "work"),
                  jobs_file=str(tmp_path / "jobs.json"), dry_run=True, writer="sample")
    values.update(overrides)
    return Settings(**values)


def wait_for(client, job_id, timeout=10):
    end = time.time() + timeout
    while time.time() < end:
        job = client.get(f"/jobs/{job_id}", headers=AUTH).json()
        if job["status"] in ("done", "failed"):
            return job
        time.sleep(0.02)
    raise AssertionError(f"job {job_id} did not finish: {job}")


def fake_result(job, progress):
    progress("rendering", title="A lesson")
    progress("uploading")
    return {"title": "A lesson", "youtubeUrl": "https://www.youtube.com/watch?v=abcdefghijk",
            "privacy": "dry-run"}


# --- API --------------------------------------------------------------------

def test_secret_is_required(tmp_path):
    with TestClient(create_app(make_settings(tmp_path), fake_result)) as client:
        assert client.post("/jobs", json=BODY).status_code == 401
        assert client.post("/jobs", json=BODY, headers={"X-Video-Secret": "nope"}).status_code == 401
        assert client.get("/jobs/x").status_code == 401
        assert client.get("/jobs").status_code == 401


def test_short_secret_refuses_to_start(tmp_path):
    with pytest.raises(SystemExit):
        create_app(make_settings(tmp_path, secret="short"), fake_result)


@pytest.mark.parametrize("change", [
    {"subject": "History"}, {"grade": 7}, {"grade": 13}, {"language": "fr"},
    {"voice": "azure"}, {"board": "green"}, {"topic": "  x "}, {"topic": "x" * 1001},
    {"source": {"mediaType": "text/html", "data": "eA=="}},
])
def test_rejects_bad_requests(tmp_path, change):
    with TestClient(create_app(make_settings(tmp_path), fake_result)) as client:
        assert client.post("/jobs", json={**BODY, **change}, headers=AUTH).status_code == 422


def test_job_runs_to_done_and_is_saved_to_file(tmp_path):
    with TestClient(create_app(make_settings(tmp_path), fake_result)) as client:
        res = client.post("/jobs", json=BODY, headers=AUTH)
        assert res.status_code == 202
        job = wait_for(client, res.json()["jobId"])
    assert job["status"] == "done"
    assert job["step"] == "Done"
    assert job["title"] == "A lesson"
    assert job["youtubeUrl"].endswith("abcdefghijk")
    assert job["subject"] == "Mathematics" and job["grade"] == 12
    saved = json.loads((tmp_path / "jobs.json").read_text(encoding="utf-8"))
    assert saved[0]["status"] == "done"


def test_board_reaches_the_renderer(tmp_path):
    seen = []
    run = lambda job, progress: seen.append(job["board"]) or fake_result(job, progress)
    with TestClient(create_app(make_settings(tmp_path), run)) as client:
        black = client.post("/jobs", json={**BODY, "board": "black"}, headers=AUTH).json()["jobId"]
        white = client.post("/jobs", json=BODY, headers=AUTH).json()["jobId"]
        assert wait_for(client, black)["board"] == "black"
        assert wait_for(client, white)["board"] == "white"
    assert seen == ["black", "white"]


def test_unknown_job_is_404(tmp_path):
    with TestClient(create_app(make_settings(tmp_path), fake_result)) as client:
        assert client.get("/jobs/does-not-exist", headers=AUTH).status_code == 404


def test_failure_is_reported(tmp_path):
    def boom(job, progress):
        raise RuntimeError("model did not return JSON")

    with TestClient(create_app(make_settings(tmp_path), boom)) as client:
        job = wait_for(client, client.post("/jobs", json=BODY, headers=AUTH).json()["jobId"])
    assert job["status"] == "failed"
    assert job["error"] == "model did not return JSON"


def test_jobs_run_one_at_a_time_in_order(tmp_path):
    running, most, order = [0], [0], []
    lock = threading.Lock()

    def slow(job, progress):
        with lock:
            running[0] += 1
            most[0] = max(most[0], running[0])
        order.append(job["topic"])
        time.sleep(0.1)
        with lock:
            running[0] -= 1
        return {"title": job["topic"], "youtubeUrl": "u" + job["topic"], "privacy": "dry-run"}

    with TestClient(create_app(make_settings(tmp_path), slow)) as client:
        ids = [client.post("/jobs", json={**BODY, "topic": f"topic {i}"}, headers=AUTH).json()["jobId"]
               for i in range(3)]
        assert client.get(f"/jobs/{ids[2]}", headers=AUTH).json()["status"] == "queued"
        jobs = [wait_for(client, i) for i in ids]
        listed = client.get("/jobs", headers=AUTH).json()["jobs"]
    assert most[0] == 1
    assert order == ["topic 0", "topic 1", "topic 2"]
    assert all(j["status"] == "done" for j in jobs)
    assert [j["id"] for j in listed] == ids[::-1]  # newest first


def test_queue_limit(tmp_path):
    gate = threading.Event()

    def blocked(job, progress):
        gate.wait(5)
        return {"title": "t", "youtubeUrl": "u", "privacy": None}

    settings = make_settings(tmp_path, max_queued=2)
    with TestClient(create_app(settings, blocked)) as client:
        first = client.post("/jobs", json=BODY, headers=AUTH).json()["jobId"]
        while client.get(f"/jobs/{first}", headers=AUTH).json()["status"] == "queued":
            time.sleep(0.01)
        codes = [client.post("/jobs", json=BODY, headers=AUTH).status_code for _ in range(3)]
        gate.set()
    # one running, two waiting, the next is turned away
    assert codes == [202, 202, 429]


def test_missing_setup_is_reported_before_queueing(tmp_path, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    settings = make_settings(tmp_path, dry_run=False, writer="anthropic")
    with TestClient(create_app(settings, fake_result)) as client:
        res = client.post("/jobs", json={**BODY, "voice": "piper"}, headers=AUTH)
    assert res.status_code == 503
    detail = res.json()["detail"]
    assert "ANTHROPIC_API_KEY" in detail and "PIPER_VOICE_EN" in detail and "YOUTUBE_CLIENT_ID" in detail


def test_restart_fails_half_done_jobs_and_resumes_queued_ones(tmp_path):
    base = {**BODY, "title": None, "youtubeUrl": None, "privacy": None, "error": None,
            "createdAt": "", "updatedAt": "", "step": ""}
    (tmp_path / "jobs.json").write_text(json.dumps([
        {**base, "id": "a", "status": "rendering"},
        {**base, "id": "b", "status": "queued"},
        {**base, "id": "c", "status": "done", "youtubeUrl": "kept"},
    ]), encoding="utf-8")
    with TestClient(create_app(make_settings(tmp_path), fake_result)) as client:
        b = wait_for(client, "b")
        a = client.get("/jobs/a", headers=AUTH).json()
        c = client.get("/jobs/c", headers=AUTH).json()
    assert a["status"] == "failed" and "restarted" in a["error"]
    assert b["status"] == "done"
    assert c["youtubeUrl"] == "kept"


# --- pipeline ----------------------------------------------------------------

def fake_cover_step(mp4, lesson, job, outputs, settings):
    cover = os.path.join(outputs, "cover.jpg")
    with open(cover, "wb") as fh:
        fh.write(b"jpg")
    with_cover = mp4.replace(".mp4", "-cover.mp4")
    os.replace(mp4, with_cover)
    return with_cover, cover, pipeline.cover_details(lesson, job)


def test_cover_prefers_the_teachers_topic_and_subtopic():
    job = {**BODY, "coverTopic": "Calculus", "subtopic": "Turning points"}
    d = pipeline.cover_details(LESSON, job)
    assert (d["topic"], d["subtopic"], d["grades"], d["subject"]) == ("Calculus", "Turning points", [12], "Mathematics")
    # without them: the AI's topic and subtopic
    d = pipeline.cover_details({**LESSON, "topic": "Differential Calculus", "subtopic": "Stationary points"}, BODY)
    assert (d["topic"], d["subtopic"]) == ("Differential Calculus", "Stationary points")
    # an old lesson without a topic: the start of the request
    d = pipeline.cover_details(LESSON, BODY)
    assert d["topic"] == BODY["topic"][:80]


def test_a_refused_thumbnail_does_not_fail_the_video(tmp_path, monkeypatch):
    settings = make_settings(tmp_path, dry_run=False)

    def refuse(video_id, image, s):
        raise RuntimeError("<HttpError 403 ... 'forbidden'>")

    monkeypatch.setitem(sys.modules, "youtube_upload", SimpleNamespace(set_thumbnail=refuse))
    assert pipeline.thumbnail_step("VIDEO123456", "cover.jpg", settings) == "not-allowed"


def test_job_request_cleans_the_cover_text(tmp_path):
    from app import JobRequest
    request = JobRequest(**{**BODY, "coverTopic": "  Differential   calculus ", "subtopic": "   "})
    assert request.coverTopic == "Differential calculus" and request.subtopic is None
    settings = make_settings(tmp_path)
    with TestClient(create_app(settings, lambda job, progress: {"title": "t"})) as client:
        too_long = client.post("/jobs", json={**BODY, "subtopic": "x" * 121}, headers=AUTH)
        assert too_long.status_code == 422


def test_cover_picture_is_drawn(tmp_path):
    import cover
    out = cover.make_cover({"subject": "Mathematics", "grades": [10, 11, 12], "topic": "Algebra",
                            "subtopic": "Factorising trinomials", "language": "en"}, str(tmp_path / "c.jpg"))
    from PIL import Image
    assert Image.open(out).size == (1280, 720)
    assert cover.grades_label([12]) == "Grade 12"
    assert cover.grades_label([10, 11, 12]) == "Grades 10–12"
    assert cover.grades_label([8, 12]) == "Grades 8 & 12"
    assert cover.grades_label([11], "af") == "Graad 11"


def test_pipeline_uploads_and_deletes_the_mp4(tmp_path, monkeypatch):
    settings = make_settings(tmp_path, dry_run=False, writer="anthropic")
    seen = {}

    def render(lesson_path, out_path, job, s):
        seen["lesson"] = json.loads(open(lesson_path, encoding="utf-8").read())
        with open(out_path, "wb") as fh:
            fh.write(b"mp4")
        seen["mp4"] = out_path
        return out_path

    def upload(path, title, description, language, s):
        seen["upload"] = (os.path.exists(path), title, description, language, path)
        return "VIDEO123456", "private"

    def set_thumbnail(video_id, image, s):
        seen["thumbnail"] = (video_id, os.path.basename(image))

    monkeypatch.setattr(pipeline, "write_step", lambda job, s, source=None: LESSON)
    monkeypatch.setattr(pipeline, "documents_step", lambda *a: None)
    monkeypatch.setattr(pipeline, "render_step", render)
    monkeypatch.setattr(pipeline, "cover_step", fake_cover_step)
    monkeypatch.setitem(sys.modules, "youtube_upload", SimpleNamespace(upload=upload, set_thumbnail=set_thumbnail))
    steps = []
    job = {"id": "job1", **BODY}
    result = pipeline.make_runner(settings)(job, lambda status, **f: steps.append(status))

    assert steps == ["documents", "rendering", "uploading"]
    assert result == {"title": "Stationary points of a cubic",
                      "youtubeUrl": "https://www.youtube.com/watch?v=VIDEO123456",
                      "privacy": "private", "files": ["activity", "memo", "cover"],
                      "lessonTopic": "Stationary points", "subtopic": None, "thumbnail": "set"}
    exists, title, description, language, uploaded = seen["upload"]
    assert uploaded.endswith("-cover.mp4")  # the video with its cover is what goes up
    assert seen["thumbnail"] == ("VIDEO123456", "cover.jpg")
    assert exists and title == "Stationary points of a cubic" and language == "en"
    assert "Title: Stationary points of a cubic" in description
    assert "Subject: Mathematics" in description and "Grade: 12" in description
    assert "Topic: Stationary points" in description
    assert not os.path.exists(seen["mp4"])
    assert not os.path.exists(os.path.join(settings.work_dir, "job1"))


def test_dry_run_skips_youtube(tmp_path, monkeypatch):
    settings = make_settings(tmp_path)
    monkeypatch.setitem(sys.modules, "youtube_upload", None)  # importing it would fail
    video_id, url, privacy = pipeline.upload_step("x.mp4", LESSON, {"id": "j", **BODY}, settings)
    assert privacy == "dry-run"
    assert url.startswith("https://www.youtube.com/watch?v=")
    assert len(url.rsplit("=", 1)[1]) == 11


def png_bytes(size=(40, 20)):
    from PIL import Image
    out = io.BytesIO()
    Image.new("RGB", size, "red").save(out, "PNG")
    return out.getvalue()


def attached(data, media_type):
    return {"mediaType": media_type, "data": base64.b64encode(data).decode()}


def test_dry_run_keeps_the_files_to_download(tmp_path, monkeypatch):
    settings = make_settings(tmp_path)

    def documents(job, lesson, source, out_dir, s):
        for name in ("activity.pdf", "memo.pdf"):
            with open(os.path.join(out_dir, name), "wb") as fh:
                fh.write(b"%PDF-")

    def render(lesson_path, out_path, job, s):
        with open(out_path, "wb") as fh:
            fh.write(b"mp4")
        return out_path

    monkeypatch.setattr(pipeline, "write_step", lambda job, s, source=None: LESSON)
    monkeypatch.setattr(pipeline, "documents_step", documents)
    monkeypatch.setattr(pipeline, "render_step", render)
    monkeypatch.setattr(pipeline, "cover_step", fake_cover_step)
    with TestClient(create_app(settings, pipeline.make_runner(settings))) as client:
        job = wait_for(client, client.post("/jobs", json=BODY, headers=AUTH).json()["jobId"])
        assert job["files"] == ["video", "activity", "memo", "cover"]
        assert client.get(f"/jobs/{job['id']}/files/cover", headers=AUTH).headers["content-type"] == "image/jpeg"
        url = f"/jobs/{job['id']}/files"
        assert client.get(f"{url}/memo").status_code == 401
        assert client.get(f"{url}/video", headers=AUTH).content == b"mp4"
        assert client.get(f"{url}/memo", headers=AUTH).headers["content-type"] == "application/pdf"
        assert client.get(f"{url}/secrets", headers=AUTH).status_code == 422
        assert client.get("/jobs/nope/files/memo", headers=AUTH).status_code == 404


def test_attached_picture_reaches_the_writer_and_is_then_deleted(tmp_path, monkeypatch):
    settings = make_settings(tmp_path)
    seen = {}

    def write(job, s, source=None):
        seen.update(source)
        raise RuntimeError("stop here")

    monkeypatch.setattr(pipeline, "write_step", write)
    body = {**BODY, "source": attached(png_bytes((3000, 1000)), "image/png")}
    with TestClient(create_app(settings, pipeline.make_runner(settings))) as client:
        job = wait_for(client, client.post("/jobs", json=body, headers=AUTH).json()["jobId"])
    assert job["status"] == "failed" and "source" not in job
    assert seen["media_type"] == "image/jpeg"
    from PIL import Image
    assert max(Image.open(io.BytesIO(base64.b64decode(seen["data"]))).size) == sources.IMAGE_EDGE
    assert os.listdir(settings.uploads_dir) == []


@pytest.mark.parametrize("source", [
    attached(b"<html>", "application/pdf"),
    attached(b"not a picture", "image/png"),
    attached(png_bytes(), "image/jpeg"),
    {"mediaType": "image/png", "data": "***"},
])
def test_bad_attachments_are_refused(tmp_path, source):
    with TestClient(create_app(make_settings(tmp_path), fake_result)) as client:
        assert client.post("/jobs", json={**BODY, "source": source}, headers=AUTH).status_code == 400


def test_source_goes_before_the_request_text():
    pdf = {"media_type": "application/pdf", "data": "AAAA"}
    content = script_writer.with_source("Topic", pdf)
    assert content[0] == {"type": "document", "source": {"type": "base64", **pdf}}
    assert content[1]["text"].startswith("Topic")
    assert script_writer.with_source("Topic", None) == "Topic"
    picture = {"media_type": "image/jpeg", "data": "AAAA"}
    assert script_writer.with_source("Topic", picture)[0]["type"] == "image"


def test_unreadable_file_stops_without_retrying(monkeypatch):
    calls = []
    monkeypatch.setattr(script_writer, "call_model",
                        lambda *a: calls.append(1) or '{"unreadable": "the photo is blurry"}')
    with pytest.raises(script_writer.SourceError, match="blurry"):
        script_writer.write_lesson("Mathematics", 9, "Explain this")
    assert len(calls) == 1


@pytest.mark.parametrize("text", [
    r"\input{secret}", r"$\input{secret}$", r"\include{a}", r"$x^^5cinput$", r"$\def\a{1}$",
    r"\immediate\write18{dir}", r"\begin{filecontents}{a}",
])
def test_tex_that_reaches_files_is_rejected(text):
    with pytest.raises(lesson_schema.LessonError, match="not allowed"):
        lesson_schema.clean_bullet(text)


def test_ordinary_maths_commands_are_allowed():
    assert lesson_schema.clean_maths(r"\left(\frac{1}{2}\right)^{2} \leq \delta")


ACTIVITY = {"title": "50% & more_", "instructions": "Show all working.", "questions": [
    {"text": "Simplify $2^3 \\times 2^2$.", "marks": 2, "answer": ["$2^{3+2}$", "$= 2^5$"]},
    {"text": "Calculate $3^2$.", "marks": 1, "answer": ["$9$"]},
    {"text": "Calculate $5^0$.", "marks": 1, "answer": ["$1$"]},
]}
DETAILS = {"subject": "Mathematics", "grade": 9, "language": "en"}


@pytest.mark.parametrize("change, message", [
    ({"questions": []}, "questions"),
    ({"title": " "}, "title"),
    ({"questions": [{**ACTIVITY["questions"][0], "marks": 0}] * 3}, "marks"),
    ({"questions": [{**ACTIVITY["questions"][0], "answer": []}] * 3}, "answer"),
    ({"questions": [{**ACTIVITY["questions"][0], "text": r"\\input{x}"}] * 3}, "not allowed"),
])
def test_bad_activities_are_rejected(change, message):
    with pytest.raises(lesson_schema.LessonError, match=message):
        worksheet.validate_activity({**ACTIVITY, **change})


def test_only_the_memo_has_the_answers():
    activity = worksheet.tex_document(ACTIVITY, DETAILS, memo=False)
    memo = worksheet.tex_document(ACTIVITY, DETAILS, memo=True)
    assert "2^{3+2}" in memo and "2^{3+2}" not in activity
    assert "Name:" in activity and "Name:" not in memo
    assert r"50\% \& more\_" in activity and "Total: 4 marks" in memo


@pytest.mark.skipif(not shutil.which("pdflatex"), reason="needs LaTeX")
def test_pdfs_are_typeset(tmp_path):
    worksheet.make_pdfs(worksheet.validate_activity(ACTIVITY), {**DETAILS, "language": "af"}, str(tmp_path))
    for name in ("activity.pdf", "memo.pdf"):
        assert (tmp_path / name).read_bytes().startswith(b"%PDF-")


def test_sample_writer_uses_the_sample_lesson(tmp_path):
    lesson = pipeline.write_step({**BODY}, make_settings(tmp_path))
    assert lesson["scenes"] and lesson["title"]


def test_render_gets_the_voice_and_board(tmp_path, monkeypatch):
    calls = {}
    fake = SimpleNamespace(render=lambda *a, **k: calls.update(args=a, kwargs=k) or a[1])
    monkeypatch.setitem(sys.modules, "render_lesson", fake)
    settings = make_settings(tmp_path, piper_voices={"en": "en.onnx", "af": "af.onnx"}, quality="l")
    pipeline.render_step("l.json", "o.mp4", {**BODY, "language": "af", "voice": "piper"}, settings)
    assert calls["kwargs"] == {"tts_backend": "piper", "quality": "l", "voice_model": "af.onnx",
                               "board": "white"}
    pipeline.render_step("l.json", "o.mp4", {**BODY, "board": "black"}, settings)
    assert calls["kwargs"]["board"] == "black"


def test_library_voice_uses_its_own_file(tmp_path, monkeypatch):
    calls = {}
    fake = SimpleNamespace(render=lambda *a, **k: calls.update(k) or a[1])
    monkeypatch.setitem(sys.modules, "render_lesson", fake)
    pipeline.render_step("l.json", "o.mp4", {**BODY, "voice": "piper-cori"}, make_settings(tmp_path))
    assert calls["tts_backend"] == "piper"
    assert calls["voice_model"] == config.library_model("piper-cori")


@pytest.mark.parametrize("voice", config.PIPER_LIBRARY)
def test_library_voices_are_credited(voice):
    _, description = pipeline.video_details({"title": "T"}, {**BODY, "voice": voice})
    assert config.PIPER_LIBRARY[voice]["credit"] in description
    _, plain = pipeline.video_details({"title": "T"}, {**BODY})
    assert "Narration" not in plain


def test_library_voice_problems_are_reported(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "VOICE_DIR", str(tmp_path))
    settings = make_settings(tmp_path)
    assert "get_voices" in " ".join(settings.problems("en", "piper-cori"))
    (tmp_path / "en_GB-cori-medium.onnx").write_bytes(b"x")
    (tmp_path / "en_GB-cori-medium.onnx.json").write_text("{}")
    assert settings.problems("en", "piper-cori") == []
    assert "only speaks English" in " ".join(settings.problems("af", "piper-cori"))


def test_youtube_titles_are_cleaned():
    title, _ = pipeline.video_details({"title": "<b>" + "x" * 200}, {**BODY})
    assert "<" not in title and len(title) == 100


# --- lesson check ------------------------------------------------------------

def graph(function, x_range=(-4, 4, 1), y_range=(-5, 5, 1), **extra):
    return {"type": "graph", "heading": "G", "narration": "n", "function": function,
            "x_range": list(x_range), "y_range": list(y_range), **extra}


def lesson_with(scene):
    return {"title": "T", "subject": "Mathematics", "grade": 12, "language": "en", "scenes": [scene]}


@pytest.mark.parametrize("function, x_range, y_range, count", [
    ("1/x", (-4, 4, 1), (-5, 5, 1), 2),
    ("log(x)", (0, 5, 1), (-3, 3, 1), 1),
    ("sqrt(x)", (-2, 5, 1), (-1, 3, 1), 1),
    ("tan(x)", (-3, 3, 1), (-5, 5, 1), 3),
    ("2", (-3, 3, 1), (-1, 3, 1), 1),
])
def test_curves_are_cut_into_pieces_on_the_axes(function, x_range, y_range, count):
    pieces = lesson_schema.curve_pieces(graph(function, x_range, y_range))
    assert len(pieces) == count
    for _, ys in pieces:
        assert ys.min() >= y_range[0] and ys.max() <= y_range[1]


def test_curve_off_the_axes_is_rejected():
    with pytest.raises(lesson_schema.LessonError, match="outside"):
        lesson_schema.validate_lesson(lesson_with(graph("x + 100")))


def test_point_where_the_curve_is_undefined_is_rejected():
    scene = graph("1/x", points=[{"x": 0, "y": 0, "label": "A"}])
    with pytest.raises(lesson_schema.LessonError, match="undefined"):
        lesson_schema.validate_lesson(lesson_with(scene))


def test_only_turning_points_count_as_flat():
    scene = graph("x**3 - 3*x**2 - 9*x + 5", (-3, 5, 1), (-30, 20, 10))
    assert lesson_schema.is_turning_point(scene, -1)
    assert lesson_schema.is_turning_point(scene, 3)
    assert not lesson_schema.is_turning_point(scene, 0)


def test_real_asymptotes_are_accepted():
    for function, lines in [("4/(x + 2) - 1", {"x": [-2], "y": [-1]}), ("log(x + 3)", {"x": [-3]}),
                            ("exp(-x) + 1", {"y": [1]})]:
        lesson_schema.validate_lesson(lesson_with(graph(function, asymptotes=lines)))


@pytest.mark.parametrize("lines, message", [
    ({"x": [1]}, "x = 1 is not an asymptote"),
    ({"y": [2]}, "y = 2 is not an asymptote"),
    ({"x": [9]}, "outside x_range"),
    ({"y": [9]}, "outside y_range"),
])
def test_wrong_asymptotes_are_rejected(lines, message):
    scene = graph("4/(x + 2) - 1", asymptotes=lines)
    with pytest.raises(lesson_schema.LessonError, match=message):
        lesson_schema.validate_lesson(lesson_with(scene))


@pytest.mark.parametrize("function, x_range, near", [
    ("4/(x + 2) - 1", (-4, 4, 1), -2),
    ("1/x", (-4.1, 4, 1), 0),
    ("0.2/x", (-4, 4, 1), 0),
    ("1/x**2", (-4, 4, 1), 0),
    ("log(x + 3)", (-5, 5, 1), -3),
    ("log(x)", (0, 5, 1), 0),
])
def test_unlisted_vertical_asymptotes_are_rejected(function, x_range, near):
    with pytest.raises(lesson_schema.LessonError, match="list it in asymptotes"):
        lesson_schema.validate_lesson(lesson_with(graph(function, x_range)))
    scene = graph(function, x_range, asymptotes={"x": [near]})
    lesson_schema.validate_lesson(lesson_with(scene))


def test_tan_needs_each_of_its_asymptotes():
    x = 1.5708
    with pytest.raises(lesson_schema.LessonError, match="list it in asymptotes"):
        lesson_schema.validate_lesson(lesson_with(graph("tan(x)", (-3, 3, 1), asymptotes={"x": [x]})))
    lesson_schema.validate_lesson(lesson_with(graph("tan(x)", (-3, 3, 1), asymptotes={"x": [-x, x]})))


@pytest.mark.parametrize("function, x_range, y_range", [
    ("x**2", (-3, 3, 1), (-1, 9, 1)),
    ("x**5", (-10, 10, 1), (-5, 5, 1)),
    ("sqrt(x)", (-2, 5, 1), (-1, 3, 1)),
    ("exp(x)", (-3, 3, 1), (-1, 9, 1)),
    ("sin(x)", (-6, 6, 1), (-2, 2, 1)),
    ("Abs(x)", (-3, 3, 1), (-1, 3, 1)),
    ("2", (-3, 3, 1), (-1, 3, 1)),
])
def test_curves_without_vertical_asymptotes_need_none(function, x_range, y_range):
    assert lesson_schema.vertical_asymptotes(graph(function, x_range, y_range)) == []


@pytest.mark.parametrize("scene", [
    {"type": "title", "heading": "H", "subheading": r"Sketching $y = \frac{a}{x}$", "narration": "n"},
    {"type": "steps", "heading": r"Solve \(x\)", "lines": ["x = 1"], "narration": "n"},
])
def test_latex_in_headings_is_rejected(scene):
    with pytest.raises(lesson_schema.LessonError, match="plain text"):
        lesson_schema.validate_lesson(lesson_with(scene))


@pytest.mark.parametrize("text, expected", [
    ("Interest of 15%", r"Interest of 15\%"),
    (r"Already 15\%", r"Already 15\%"),
    ("Profit & loss", r"Profit \& loss"),
    ("Question #3 uses x_1", r"Question \#3 uses x\_1"),
    ("x ≥ 2", r"x $\geq$ 2"),
    ("Dit is ŉ reël", "Dit is 'n reël"),
    ("So $x ≥ 2$", r"So $x \geq  2$"),
])
def test_bullets_are_made_safe_for_latex(text, expected):
    assert lesson_schema.clean_bullet(text) == expected


def test_maths_lines_are_made_safe_for_latex():
    assert lesson_schema.clean_maths(r"x &= 15\% + 2%") == r"x = 15\% + 2\%"
    assert lesson_schema.clean_maths(r"\text{R&D ≥ 2}") == r"\text{R\&D $\geq$ 2}"


@pytest.mark.parametrize("bullet, message", [
    ("costs $5", "unmatched"), ("$x{$", "braces"), ("√ of 4", "unsupported"),
])
def test_bad_bullets_are_rejected_with_their_scene(bullet, message):
    scene = {"type": "bullets", "heading": "B", "narration": "n", "bullets": [bullet]}
    with pytest.raises(lesson_schema.LessonError, match=f"scene 0.*{message}"):
        lesson_schema.validate_lesson(lesson_with(scene))


# --- YouTube upload ----------------------------------------------------------

class FakeRequest:
    def __init__(self, outcomes):
        self.outcomes = list(outcomes)

    def next_chunk(self):
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return None, outcome


def fake_youtube(monkeypatch, outcomes, captured):
    from googleapiclient import discovery, http

    class Videos:
        def insert(self, **kwargs):
            captured.update(kwargs)
            return FakeRequest(outcomes)

    monkeypatch.setattr(discovery, "build",
                        lambda *a, **k: SimpleNamespace(videos=lambda: Videos()))
    monkeypatch.setattr(http, "MediaFileUpload",
                        lambda path, **k: captured.setdefault("media", (path, k)))


def test_upload_sends_the_right_details(tmp_path, monkeypatch):
    captured = {}
    fake_youtube(monkeypatch, [{"id": "abc", "status": {"privacyStatus": "private"}}], captured)
    settings = make_settings(tmp_path, youtube_privacy="unlisted", made_for_kids=False,
                             youtube_client_id="id", youtube_client_secret="s",
                             youtube_refresh_token="r")
    assert youtube_upload.upload("v.mp4", "Title", "Desc", "af", settings) == ("abc", "private")
    body = captured["body"]
    assert body["snippet"]["categoryId"] == "27"
    assert body["snippet"]["title"] == "Title" and body["snippet"]["defaultLanguage"] == "af"
    assert body["status"] == {"privacyStatus": "unlisted", "selfDeclaredMadeForKids": False,
                              "embeddable": True}
    assert captured["media"][1]["resumable"] is True
    assert captured["media"][1]["mimetype"] == "video/mp4"


def test_upload_retries_server_errors(tmp_path, monkeypatch):
    from googleapiclient.errors import HttpError

    def server_error(status):
        return HttpError(SimpleNamespace(status=status, reason="x"), b"{}")

    captured, sleeps = {}, []
    fake_youtube(monkeypatch, [server_error(503), ConnectionError("reset"),
                               {"id": "xyz", "status": {"privacyStatus": "unlisted"}}], captured)
    result = youtube_upload.upload("v.mp4", "T", "D", "en", make_settings(tmp_path),
                                   sleep=sleeps.append)
    assert result == ("xyz", "unlisted")
    assert len(sleeps) == 2


def test_upload_does_not_retry_client_errors(tmp_path, monkeypatch):
    from googleapiclient.errors import HttpError

    forbidden = HttpError(SimpleNamespace(status=403, reason="quotaExceeded"), b"{}")
    fake_youtube(monkeypatch, [forbidden], {})
    with pytest.raises(HttpError):
        youtube_upload.upload("v.mp4", "T", "D", "en", make_settings(tmp_path), sleep=lambda s: None)
