"""Settings for the lesson-video service, read from environment variables.

Values in ai/service/.env are loaded first (that file is git-ignored), so you
don't have to set them in every terminal. Real environment variables win.
"""

import os
import shutil
from dataclasses import dataclass, field

HERE = os.path.dirname(os.path.abspath(__file__))
VIDEO_DIR = os.path.normpath(os.path.join(HERE, "..", "video"))
SAMPLE_LESSON = os.path.join(VIDEO_DIR, "lessons", "gr12-maths-stationary-points.json")
VOICE_DIR = os.path.normpath(os.path.join(HERE, "..", "voice", "voices"))

# Ready-made English voices, fetched by ai/voice/get_voices.py. Their licences
# require credit, so the credit goes in each video's YouTube description.
PIPER_LIBRARY = {
    "piper-cori": {
        "path": "en/en_GB/cori/medium",
        "file": "en_GB-cori-medium.onnx",
        "credit": "Narration: Piper voice \"cori\", the voice of Cori Samuel, from the Hi-Fi "
                  "Multi-Speaker English TTS Dataset by NVIDIA (CC BY 4.0).",
    },
    "piper-northern-male": {
        "path": "en/en_GB/northern_english_male/medium",
        "file": "en_GB-northern_english_male-medium.onnx",
        "credit": "Narration: Piper voice \"northern_english_male\", from OpenSLR dataset 83 "
                  "(CC BY-SA 4.0).",
    },
}

# Same list as the Create video form in the app
SUBJECTS = (
    "Mathematics", "Mathematical Literacy", "Technical Mathematics", "Life Sciences",
    "Physical Sciences", "Geography", "EGD", "Accounting", "Economics",
    "Business Studies", "English", "Afrikaans",
)
GRADES = (8, 9, 10, 11, 12)
LANGUAGES = ("en", "af")
VOICES = ("espeak", "piper", *PIPER_LIBRARY)
PRIVACY = ("private", "unlisted", "public")
MAX_TOPIC = 1000
MAX_SOURCE_MB = 10
# What a finished job can hand back: name -> (file, content type)
JOB_FILES = {
    "video": ("lesson.mp4", "video/mp4"),
    "activity": ("activity.pdf", "application/pdf"),
    "memo": ("memo.pdf", "application/pdf"),
}
# Finished jobs whose files are kept
KEEP_OUTPUTS = 30


def library_model(voice: str) -> str:
    return os.path.join(VOICE_DIR, PIPER_LIBRARY[voice]["file"])


def load_env_file(path=os.path.join(HERE, ".env")):
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def _flag(name, default=False):
    value = os.environ.get(name, "").strip().lower()
    if not value:
        return default
    return value in ("1", "true", "yes", "on")


@dataclass
class Settings:
    secret: str
    port: int = 8765
    work_dir: str = os.path.join(HERE, "work")
    jobs_file: str = os.path.join(HERE, "jobs.json")
    dry_run: bool = False
    # "anthropic" writes each lesson with Claude; "sample" always uses the
    # sample lesson (for testing the pipeline without an API key)
    writer: str = "anthropic"
    quality: str = "m"
    piper_voices: dict = field(default_factory=dict)
    youtube_client_id: str = ""
    youtube_client_secret: str = ""
    youtube_refresh_token: str = ""
    youtube_privacy: str = "unlisted"
    made_for_kids: bool = False
    max_queued: int = 20

    @property
    def uploads_dir(self) -> str:
        return os.path.join(self.work_dir, "uploads")

    @property
    def outputs_dir(self) -> str:
        return os.path.join(self.work_dir, "outputs")

    def problems(self, language: str, voice: str) -> list:
        """Reasons a job with these options can't run, so the app can say so
        straight away instead of after minutes of rendering."""
        found = []
        if self.writer == "anthropic" and not os.environ.get("ANTHROPIC_API_KEY"):
            found.append("ANTHROPIC_API_KEY is not set for the video service.")
        if voice == "piper" and not self.piper_voices.get(language):
            name = "PIPER_VOICE_" + language.upper()
            found.append(f"The piper voice needs {name} (a .onnx voice file) set for the video service.")
        if voice in PIPER_LIBRARY:
            model = library_model(voice)
            if language != "en":
                found.append("That voice only speaks English.")
            elif not (os.path.exists(model) and os.path.exists(model + ".json")):
                found.append("That voice isn't downloaded yet: run python ai/voice/get_voices.py.")
        if not self.dry_run and not (
            self.youtube_client_id and self.youtube_client_secret and self.youtube_refresh_token
        ):
            found.append("YouTube isn't connected: set YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET and "
                         "YOUTUBE_REFRESH_TOKEN (see ai/service/README.md), or DRY_RUN=1 to test.")
        return found


def load_settings() -> Settings:
    load_env_file()
    privacy = os.environ.get("YOUTUBE_PRIVACY", "unlisted").strip().lower()
    if privacy not in PRIVACY:
        raise SystemExit(f"YOUTUBE_PRIVACY must be one of {', '.join(PRIVACY)}")
    writer = os.environ.get("WRITER", "anthropic").strip().lower()
    if writer not in ("anthropic", "sample"):
        raise SystemExit("WRITER must be anthropic or sample")
    return Settings(
        secret=os.environ.get("VIDEO_SERVICE_SECRET", ""),
        port=int(os.environ.get("VIDEO_SERVICE_PORT", "8765")),
        work_dir=os.environ.get("VIDEO_WORK_DIR") or os.path.join(HERE, "work"),
        dry_run=_flag("DRY_RUN"),
        writer=writer,
        quality=os.environ.get("RENDER_QUALITY", "m"),
        piper_voices={lang: os.environ.get("PIPER_VOICE_" + lang.upper(), "") for lang in LANGUAGES},
        youtube_client_id=os.environ.get("YOUTUBE_CLIENT_ID", ""),
        youtube_client_secret=os.environ.get("YOUTUBE_CLIENT_SECRET", ""),
        youtube_refresh_token=os.environ.get("YOUTUBE_REFRESH_TOKEN", ""),
        youtube_privacy=privacy,
        # The learners are high-school age, so videos are not "made for kids"
        made_for_kids=_flag("YOUTUBE_MADE_FOR_KIDS"),
    )


def add_tools_to_path():
    """On Windows the espeak-ng and MiKTeX installers don't always put their
    programs on PATH for terminals that were already open."""
    if os.name != "nt":
        return
    extra = []
    if not shutil.which("espeak-ng"):
        extra.append(os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), "eSpeak NG"))
    if not shutil.which("latex"):
        extra += [
            os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "MiKTeX", "miktex", "bin", "x64"),
            os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), "MiKTeX", "miktex", "bin", "x64"),
        ]
    found = [d for d in extra if os.path.isdir(d)]
    if found:
        os.environ["PATH"] = os.pathsep.join(found + [os.environ.get("PATH", "")])
