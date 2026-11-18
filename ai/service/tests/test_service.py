"""Service tests. The AI writer, the renderer and YouTube are all mocked.

    cd ai/service
    python -m pytest
"""

import json
import os
import sys
import threading
import time
from types import SimpleNamespace

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import pipeline  # noqa: E402
import lesson_schema  # noqa: E402
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
    {"subject": "History"}, {"grade": 9}, {"grade": 13}, {"language": "fr"},
    {"voice": "azure"}, {"board": "green"}, {"topic": "  x "}, {"topic": "x" * 201},
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
        seen["upload"] = (os.path.exists(path), title, description, language)
        return "VIDEO123456", "private"

    monkeypatch.setattr(pipeline, "write_step", lambda job, s: LESSON)
    monkeypatch.setattr(pipeline, "render_step", render)
    monkeypatch.setitem(sys.modules, "youtube_upload", SimpleNamespace(upload=upload))
    steps = []
    job = {"id": "job1", **BODY}
    result = pipeline.make_runner(settings)(job, lambda status, **f: steps.append(status))

    assert steps == ["rendering", "uploading"]
    assert result == {"title": "Stationary points of a cubic",
                      "youtubeUrl": "https://www.youtube.com/watch?v=VIDEO123456",
                      "privacy": "private"}
    exists, title, description, language = seen["upload"]
    assert exists and title == "Stationary points of a cubic" and language == "en"
    assert "Subject: Mathematics" in description and "Grade: 12" in description
    assert "Topic: Stationary points" in description
    assert not os.path.exists(seen["mp4"])
    assert not os.path.exists(os.path.join(settings.work_dir, "job1"))


def test_dry_run_skips_youtube(tmp_path, monkeypatch):
    settings = make_settings(tmp_path)
    monkeypatch.setitem(sys.modules, "youtube_upload", None)  # importing it would fail
    url, privacy = pipeline.upload_step("x.mp4", LESSON, {"id": "j", **BODY}, settings)
    assert privacy == "dry-run"
    assert url.startswith("https://www.youtube.com/watch?v=")
    assert len(url.rsplit("=", 1)[1]) == 11


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
