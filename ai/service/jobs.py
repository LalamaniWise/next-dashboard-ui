"""Job queue for the lesson-video service.

Jobs run one at a time on a worker thread. Their status is kept in memory
and in a small JSON file, so the app can still see how a job ended after the
service restarts. Nothing here touches the app's database.
"""

import json
import logging
import os
import queue
import secrets
import threading
import time

log = logging.getLogger("video-service")

FINISHED = ("done", "failed")
KEEP_JOBS = 200

STEP_MESSAGES = {
    "queued": "Waiting for other videos to finish...",
    "writing": "Writing lesson...",
    "rendering": "Rendering...",
    "uploading": "Uploading to YouTube...",
    "done": "Done",
    "failed": "Failed",
}

PUBLIC_FIELDS = ("id", "status", "step", "subject", "grade", "topic", "language", "voice",
                 "title", "youtubeUrl", "privacy", "error", "createdAt", "updatedAt")


class QueueFull(Exception):
    pass


def _now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def friendly_error(err: Exception) -> str:
    text = str(err).strip() or err.__class__.__name__
    return text if len(text) <= 300 else text[:297] + "..."


class JobStore:
    """`run_job(job, progress)` does the work and returns the result fields
    (title, youtubeUrl, privacy). `progress(status, **fields)` records a step."""

    def __init__(self, path, run_job, max_queued=20):
        self.path = path
        self.run_job = run_job
        self.max_queued = max_queued
        self.lock = threading.Lock()
        self.jobs = {}
        self.queue = queue.Queue()
        self.worker = None
        self._load()

    # --- storage -----------------------------------------------------------
    def _load(self):
        if not os.path.exists(self.path):
            return
        try:
            with open(self.path, encoding="utf-8") as fh:
                saved = json.load(fh)
        except (OSError, ValueError) as err:
            log.warning("could not read %s: %s", self.path, err)
            return
        for job in saved:
            self.jobs[job["id"]] = job
            if job["status"] == "queued":
                self.queue.put(job["id"])
            elif job["status"] not in FINISHED:
                # It was half-way through when the service stopped
                job.update(status="failed", step=STEP_MESSAGES["failed"], updatedAt=_now(),
                           error="The video service restarted before this video was finished. "
                                 "Please create it again.")
        self._save()

    def _save(self):
        jobs = list(self.jobs.values())[-KEEP_JOBS:]
        self.jobs = {j["id"]: j for j in jobs}
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(jobs, fh, indent=1, ensure_ascii=False)
        os.replace(tmp, self.path)

    # --- api ---------------------------------------------------------------
    def submit(self, request: dict) -> dict:
        with self.lock:
            waiting = sum(1 for j in self.jobs.values() if j["status"] == "queued")
            if waiting >= self.max_queued:
                raise QueueFull(f"{waiting} videos are already waiting. Try again later.")
            job = {
                "id": secrets.token_hex(16),
                "status": "queued",
                "step": STEP_MESSAGES["queued"],
                **{k: request[k] for k in ("subject", "grade", "topic", "language", "voice")},
                "title": None,
                "youtubeUrl": None,
                "privacy": None,
                "error": None,
                "createdAt": _now(),
                "updatedAt": _now(),
            }
            self.jobs[job["id"]] = job
            self._save()
        self.queue.put(job["id"])
        return self.public(job)

    def get(self, job_id: str):
        with self.lock:
            job = self.jobs.get(job_id)
            return self.public(job) if job else None

    def recent(self, limit=20):
        with self.lock:
            return [self.public(j) for j in reversed(list(self.jobs.values())[-limit:])]

    @staticmethod
    def public(job):
        return {k: job.get(k) for k in PUBLIC_FIELDS}

    def update(self, job_id, status=None, **fields):
        with self.lock:
            job = self.jobs[job_id]
            if status:
                job["status"] = status
                job["step"] = STEP_MESSAGES[status]
            job.update(fields, updatedAt=_now())
            self._save()

    # --- worker ------------------------------------------------------------
    def start(self):
        self.worker = threading.Thread(target=self._work, name="video-worker", daemon=True)
        self.worker.start()

    def stop(self, timeout=5):
        self.queue.put(None)
        if self.worker:
            self.worker.join(timeout)

    def _work(self):
        while True:
            job_id = self.queue.get()
            if job_id is None:
                return
            with self.lock:
                job = dict(self.jobs.get(job_id) or {})
            if job.get("status") != "queued":
                continue
            log.info("job %s: %s grade %s, %s", job_id, job["subject"], job["grade"], job["topic"])
            try:
                # Every video starts by writing the lesson
                self.update(job_id, "writing")
                result = self.run_job(job, lambda status, **f: self.update(job_id, status, **f))
                self.update(job_id, "done", **result)
                log.info("job %s done: %s", job_id, result.get("youtubeUrl"))
            except Exception as err:  # noqa: BLE001 - every failure is reported on the job
                log.exception("job %s failed", job_id)
                self.update(job_id, "failed", error=friendly_error(err))
