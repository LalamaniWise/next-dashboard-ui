"""Lesson-video service for the school app.

    python app.py

Only the Next.js server talks to it, on 127.0.0.1, with the shared secret
in the X-Video-Secret header. See README.md.
"""

import hmac
import logging
import os
import sys
from contextlib import asynccontextmanager

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from fastapi import Depends, FastAPI, Header, HTTPException  # noqa: E402
from pydantic import BaseModel, Field, field_validator  # noqa: E402
from typing import Literal  # noqa: E402

from config import GRADES, SUBJECTS, Settings, add_tools_to_path, load_settings  # noqa: E402
from jobs import JobStore, QueueFull  # noqa: E402
from pipeline import make_runner  # noqa: E402

HOST = "127.0.0.1"


class JobRequest(BaseModel):
    subject: str
    grade: int = Field(ge=min(GRADES), le=max(GRADES))
    topic: str = Field(min_length=3, max_length=200)
    language: Literal["en", "af"]
    voice: Literal["espeak", "piper"]
    # white = whiteboard, black = chalkboard
    board: Literal["white", "black"] = "white"

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
        try:
            job = store.submit(request.model_dump())
        except QueueFull as err:
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
