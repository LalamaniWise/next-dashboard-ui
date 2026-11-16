"""Text-to-speech for lesson narration.

Backends
  espeak  Offline and free, robotic voice. Good for testing the pipeline.
  azure   Azure AI Speech neural voices, including South African English
          (en-ZA) and Afrikaans (af-ZA). Needs AZURE_SPEECH_KEY and
          AZURE_SPEECH_REGION environment variables.
"""

import html
import os
import subprocess
import urllib.request
import wave

AZURE_VOICES = {
    "en": ("en-ZA", os.environ.get("AZURE_VOICE_EN", "en-ZA-LeahNeural")),
    "af": ("af-ZA", os.environ.get("AZURE_VOICE_AF", "af-ZA-AdriNeural")),
}
ESPEAK_VOICES = {"en": "en-gb", "af": "af"}


def wav_duration(path: str) -> float:
    with wave.open(path, "rb") as w:
        return w.getnframes() / float(w.getframerate())


def _espeak(text: str, lang: str, out_path: str) -> None:
    subprocess.run(
        ["espeak-ng", "-v", ESPEAK_VOICES[lang], "-s", "150", "-w", out_path, text],
        check=True,
    )


def _azure(text: str, lang: str, out_path: str) -> None:
    key = os.environ["AZURE_SPEECH_KEY"]
    region = os.environ["AZURE_SPEECH_REGION"]
    locale, voice = AZURE_VOICES[lang]
    ssml = (
        f"<speak version='1.0' xml:lang='{locale}'>"
        f"<voice name='{voice}'><prosody rate='-5%'>{html.escape(text)}</prosody></voice>"
        "</speak>"
    )
    req = urllib.request.Request(
        f"https://{region}.tts.speech.microsoft.com/cognitiveservices/v1",
        data=ssml.encode("utf-8"),
        headers={
            "Ocp-Apim-Subscription-Key": key,
            "Content-Type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": "riff-24khz-16bit-mono-pcm",
            "User-Agent": "school-lesson-video",
        },
    )
    with urllib.request.urlopen(req, timeout=60) as resp, open(out_path, "wb") as f:
        f.write(resp.read())


def synthesize(text: str, lang: str, out_path: str, backend: str = "espeak") -> float:
    """Write narration to a WAV file and return its length in seconds."""
    if lang not in ESPEAK_VOICES:
        raise ValueError(f"unsupported language {lang!r}")
    {"espeak": _espeak, "azure": _azure}[backend](text, lang, out_path)
    return wav_duration(out_path)
