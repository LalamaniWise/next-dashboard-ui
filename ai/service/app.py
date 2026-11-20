"""Lesson-video service for the school app.

    python app.py

Only the Next.js server talks to it, on 127.0.0.1, with the shared secret
in the X-Video-Secret header. See README.md.
"""

import base64
import binascii
import hmac
import logging
import os
import sys
from contextlib import asynccontextmanager

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from fastapi import Depends, FastAPI, Header, HTTPException  # noqa: E402
from fastapi.responses import FileResponse  # noqa: E402
from pydantic import BaseModel, Field, field_validator  # noqa: E402
from typing import Literal, Optional  # noqa: E402

from config import (  # noqa: E402
    GRADES, JOB_FILES, MAX_SOURCE_MB, MAX_TOPIC, SUBJECTS, VOICES, Settings, add_tools_to_path,
    load_settings,
)
from jobs import JobStore, QueueFull  # noqa: E402
from pipeline import make_runner  # noqa: E402
from sources import remove_source, save_source  # noqa: E402

HOST = "127.0.0.1"


class Source(BaseModel):
    mediaType: Literal["application/pdf", "image/png", "image/jpeg", "image/webp"]
    # base64 is a third longer than the file
    data: str = Field(min_length=1, max_length=MAX_SOURCE_MB * 1024 * 1024 * 4 // 3 + 4)


class JobRequest(BaseModel):
    subject: str
    grade: int = Field(ge=min(GRADES), le=max(GRADES))
    topic: str = Field(min_length=3, max_length=MAX_TOPIC)
    language: Literal["en", "af"]
    voice: str
    # white = whiteboard, black = chalkboard
    board: Literal["white", "black"] = "white"
    # A PDF or picture to teach from
    source: Optional[Source] = None
    # On the video's cover; the AI fills in whichever is empty
    coverTopic: Optional[str] = Field(default=None, max_length=80)
    subtopic: Optional[str] = Field(default=None, max_length=120)

    @field_validator("coverTopic", "subtopic")
    @classmethod
    def clean_cover_text(cls, value):
        value = " ".join((value or "").split())
        return value or None

    @field_validator("voice")
    @classmethod
    def known_voice(cls, value):
        if value not in VOICES:
            raise ValueError("unknown voice")
        return value

    @field_validator("subject")
    @classmethod
    def known_subject(cls, value):
        if value not in SUBJECTS:
            raise ValueError("unknown subject")
        return value

    @field_validator("topic")
    @classmethod
    def clean_topic(cls, value):
        value = " ".join(value.split())
        if len(value) < 3:
            raise ValueError("topic is too short")
        return value


def create_app(settings: Settings, run_job=None) -> FastAPI:
    if len(settings.secret) < 16:
        raise SystemExit("Set VIDEO_SERVICE_SECRET (at least 16 characters) in ai/service/.env")
    os.makedirs(settings.work_dir, exist_ok=True)
    store = JobStore(settings.jobs_file, run_job or make_runner(settings), settings.max_queued)

    @asynccontextmanager
    async def lifespan(_app):
        store.start()
        yield
        store.stop()

    app = FastAPI(title="Lesson video service", lifespan=lifespan, docs_url=None, redoc_url=None,
                  openapi_url=None)
    app.state.store = store

    def check_secret(x_video_secret: str = Header(default="")):
        if not hmac.compare_digest(x_video_secret.encode(), settings.secret.encode()):
            raise HTTPException(status_code=401, detail="Wrong or missing X-Video-Secret.")

    @app.post("/jobs", status_code=202, dependencies=[Depends(check_secret)])
    def create_job(request: JobRequest):
        problems = settings.problems(request.language, request.voice)
        if problems:
            raise HTTPException(status_code=503, detail=" ".join(problems))
        fields = request.model_dump(exclude={"source"})
        if request.source:
            try:
                data = base64.b64decode(request.source.data, validate=True)
                fields["source"] = save_source(data, request.source.mediaType, settings.uploads_dir)
            except binascii.Error:
                raise HTTPException(status_code=400, detail="The attached file was damaged on the way.")
            except ValueError as err:
                raise HTTPException(status_code=400, detail=str(err))
        try:
            job = store.submit(fields)
        except QueueFull as err:
            remove_source(fields.get("source"))
            raise HTTPException(status_code=429, detail=str(err))
        return {"jobId": job["id"]}

    @app.get("/jobs", dependencies=[Depends(check_secret)])
    def list_jobs(limit: int = 20):
        return {"jobs": store.recent(max(1, min(limit, 100))), "dryRun": settings.dry_run}

    @app.get("/jobs/{job_id}", dependencies=[Depends(check_secret)])
    def get_job(job_id: str):
        job = store.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="No such job.")
        return job

    @app.get("/jobs/{job_id}/files/{kind}", dependencies=[Depends(check_secret)])
    def get_file(job_id: str, kind: Literal["video", "activity", "memo", "cover"]):
        job = store.get(job_id)
        name, media_type = JOB_FILES[kind]
        path = os.path.join(settings.outputs_dir, job_id, name)
        if not job or kind not in (job["files"] or []) or not os.path.exists(path):
            raise HTTPException(status_code=404, detail="That file isn't available.")
        return FileResponse(path, media_type=media_type)

    return app


def main():
    import uvicorn

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    settings = load_settings()
    add_tools_to_path()
    if settings.dry_run:
        logging.info("DRY_RUN is on: videos are rendered but not uploaded to YouTube")
    if settings.writer == "sample":
        logging.info("WRITER=sample: every video uses the sample lesson (testing only)")
    # 127.0.0.1 only: the service must not be reachable from other computers
    uvicorn.run(create_app(settings), host=HOST, port=settings.port, log_level="info")


if __name__ == "__main__":
    main()
