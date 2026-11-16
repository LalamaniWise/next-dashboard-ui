"""Narration audio for lessons.

Backends
  espeak    Offline and free, robotic voice. Good for testing the pipeline.
  piper     Offline neural voice from a Piper .onnx model, including a voice
            trained on your own recordings (see ai/voice). Pass --voice-model.
  recorded  Your own recordings, one file per scene (scene_00.m4a, ...).
            Pass --voice-dir. Any format ffmpeg reads: wav, mp3, m4a, webm.
  azure     Azure AI Speech neural voices, including South African English
            (en-ZA) and Afrikaans (af-ZA). Needs AZURE_SPEECH_KEY and
            AZURE_SPEECH_REGION environment variables.
"""

import glob
import html
import os
import subprocess
import urllib.request
import wave

import numpy as np

AUDIO_EXTENSIONS = (".wav", ".mp3", ".m4a", ".aac", ".ogg", ".opus", ".webm", ".flac")

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


_piper_cache = {}


def _piper(text: str, out_path: str, model_path: str) -> None:
    from piper import PiperVoice

    if model_path not in _piper_cache:
        _piper_cache[model_path] = PiperVoice.load(model_path)
    with wave.open(out_path, "wb") as wf:
        _piper_cache[model_path].synthesize_wav(text, wf)


def find_recording(voice_dir: str, scene_index: int) -> str:
    """Find scene_00.* (or scene_0.*) in voice_dir."""
    for stem in (f"scene_{scene_index:02d}", f"scene_{scene_index}"):
        for path in sorted(glob.glob(os.path.join(voice_dir, stem + ".*"))):
            if path.lower().endswith(AUDIO_EXTENSIONS):
                return path
    raise FileNotFoundError(
        f"no recording for scene {scene_index} in {voice_dir} "
        f"(expected scene_{scene_index:02d}.wav / .m4a / .mp3 / .webm)"
    )


def _decode(src, rate):
    raw = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", src, "-ac", "1",
                          "-ar", str(rate), "-f", "f32le", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).copy()


def trim_and_level(samples, rate, pad=0.12, threshold_db=-45.0, target_db=-20.0):
    """Cut silence at both ends (keeping a short pause) and level the volume.

    Done in Python rather than with ffmpeg filters, which can stall on some
    inputs (e.g. a long, constant loud sound)."""
    if samples.size == 0:
        return samples
    threshold = 10 ** (threshold_db / 20)
    loud = np.flatnonzero(np.abs(samples) > threshold)
    if loud.size == 0:
        return samples[:0]
    p = int(pad * rate)
    samples = samples[max(0, loud[0] - p): loud[-1] + p + 1]
    rms = float(np.sqrt(np.mean(samples ** 2)))
    if rms > 0:
        samples = samples * (10 ** (target_db / 20) / rms)
    peak = float(np.max(np.abs(samples)))
    if peak > 0.89:  # keep peaks below about -1 dB so nothing clips
        samples = samples * (0.89 / peak)
    return samples


def _write_wav(path, samples, rate):
    pcm = (np.clip(samples, -1, 1) * 32767).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())


def clean_recording(src: str, out_path: str) -> None:
    """Convert any recording to mono WAV, trim silence at both ends and even
    out the volume, so phone and laptop recordings sound consistent."""
    rate = 44100
    _write_wav(out_path, trim_and_level(_decode(src, rate), rate, pad=0.15, target_db=-18.0), rate)


def synthesize(text: str, lang: str, out_path: str, backend: str = "espeak",
               voice_model: str = None, voice_dir: str = None,
               scene_index: int = 0) -> float:
    """Write narration to a WAV file and return its length in seconds."""
    if lang not in ESPEAK_VOICES:
        raise ValueError(f"unsupported language {lang!r}")
    if backend == "recorded":
        if not voice_dir:
            raise ValueError("--voice-dir is required with --tts recorded")
        clean_recording(find_recording(voice_dir, scene_index), out_path)
    elif backend == "piper":
        if not voice_model:
            raise ValueError("--voice-model is required with --tts piper")
        _piper(text, out_path, voice_model)
    else:
        {"espeak": _espeak, "azure": _azure}[backend](text, lang, out_path)
    return wav_duration(out_path)
