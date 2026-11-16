"""Render a lesson JSON file into a narrated MP4.

    python render_lesson.py lessons/gr12-maths-stationary-points.json
    python render_lesson.py lesson.json --tts azure --quality h --out video.mp4
    python render_lesson.py lesson.json --tts recorded --voice-dir recordings/lesson1
    python render_lesson.py lesson.json --tts piper --voice-model my-voice.onnx

Each scene's narration is turned into audio first; the animation for that
scene is then timed to fill exactly the length of its audio, so the picture
and the voice stay in sync.
"""

import argparse
import json
import os
import shutil
import sys
import tempfile

import numpy as np
import sympy
from manim import (
    DOWN, LEFT, RIGHT, UP,
    Axes, Create, DashedLine, Dot, FadeIn, FadeOut, Flash, GrowFromCenter,
    MathTex, Scene, Tex, Text, VGroup, Write, config, tempconfig,
)

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from lesson_schema import check_function, validate_lesson  # noqa: E402
from tts import synthesize  # noqa: E402

# Colours match the school dashboard (tailwind lamaSky / lamaPurple / lamaYellow)
BG = "#F7F8FA"
INK = "#1F2937"
MUTED = "#6B7280"
SKY = "#3BA9D6"
PURPLE = "#6C63FF"
YELLOW = "#E0B000"
FONT = "Inter"

QUALITY = {"l": "low_quality", "m": "medium_quality", "h": "high_quality"}


def fit(mob, max_width):
    if mob.width > max_width:
        mob.scale_to_fit_width(max_width)
    return mob


def make_function(expr: str):
    check_function(expr)
    x = sympy.Symbol("x")
    parsed = sympy.sympify(expr, locals={"x": x})
    return sympy.lambdify(x, parsed, "numpy")


class LessonScene(Scene):
    lesson: dict = {}
    audio: list = []  # [(wav_path, seconds)] per scene

    def construct(self):
        self.camera.background_color = BG
        self.max_w = config.frame_width - 1.2
        for scene, (wav, seconds) in zip(self.lesson["scenes"], self.audio):
            self.add_sound(wav)
            builder = getattr(self, f"scene_{scene['type']}")
            used = builder(scene, seconds)
            self.wait(max(0.3, seconds - used) + 0.4)
            self.play(*[FadeOut(m) for m in self.mobjects], run_time=0.5)

    # --- helpers -----------------------------------------------------------
    def heading(self, text):
        h = fit(Text(text, font=FONT, weight="BOLD", color=INK).scale(0.7), self.max_w)
        h.to_edge(UP, buff=0.5).to_edge(LEFT, buff=1.0)
        from manim import Line
        bar = Line(LEFT, RIGHT, color=SKY, stroke_width=6)
        bar.set_width(min(h.width, 3)).next_to(h, DOWN, buff=0.15).align_to(h, LEFT)
        self.play(FadeIn(h, shift=0.2 * DOWN), Create(bar), run_time=0.8)
        return VGroup(h, bar), 0.8

    def reveal(self, items, seconds, used):
        """Reveal items one at a time, spread evenly over the narration."""
        slot = max(0.6, (seconds - used) / max(1, len(items)))
        for item in items:
            run = min(1.4, slot * 0.6)
            self.play(Write(item), run_time=run)
            self.wait(max(0, slot - run))
            used += slot
        return used

    # --- scene types ---------------------------------------------------------
    def scene_title(self, s, seconds):
        title = fit(Text(s["heading"], font=FONT, weight="BOLD", color=INK).scale(0.95), self.max_w)
        sub = fit(Text(s.get("subheading", ""), font=FONT, color=MUTED).scale(0.45), self.max_w)
        sub.next_to(title, DOWN, buff=0.4)
        from manim import Line
        line = Line(LEFT * 2, RIGHT * 2, color=YELLOW, stroke_width=8).next_to(sub, DOWN, buff=0.4)
        self.play(Write(title), run_time=1.2)
        self.play(FadeIn(sub, shift=0.2 * UP), GrowFromCenter(line), run_time=0.8)
        return 2.0

    def scene_bullets(self, s, seconds):
        head, used = self.heading(s["heading"])
        rows = VGroup(*[
            fit(Tex(r"\textbullet\ " + b, color=INK, tex_environment="flushleft"), self.max_w - 0.5)
            for b in s["bullets"]
        ]).arrange(DOWN, aligned_edge=LEFT, buff=0.5)
        rows.next_to(head, DOWN, buff=0.7).to_edge(LEFT, buff=1.0)
        return self.reveal(list(rows), seconds, used)

    def scene_steps(self, s, seconds):
        head, used = self.heading(s["heading"])
        lines = VGroup(*[fit(MathTex(line, color=INK).scale(1.15), self.max_w - 0.5)
                         for line in s["lines"]])
        lines.arrange(DOWN, aligned_edge=LEFT, buff=0.45)
        if lines.height > config.frame_height - 2.5:
            lines.scale_to_fit_height(config.frame_height - 2.5)
        lines.next_to(head, DOWN, buff=0.6).to_edge(LEFT, buff=1.0)
        # The last line is the result: give it a highlight colour.
        lines[-1].set_color(PURPLE)
        return self.reveal(list(lines), seconds, used)

    def scene_graph(self, s, seconds):
        head, used = self.heading(s["heading"])
        f = make_function(s["function"])
        xr, yr = s["x_range"], s["y_range"]
        axes = Axes(
            x_range=xr, y_range=yr, x_length=8, y_length=5.2,
            axis_config={"color": MUTED, "include_numbers": True, "font_size": 22,
                         "decimal_number_config": {"color": MUTED, "num_decimal_places": 0}},
            tips=False,
        ).next_to(head, DOWN, buff=0.35).set_x(0)
        curve = axes.plot(lambda t: float(f(t)), x_range=[xr[0], xr[1]], color=SKY,
                          stroke_width=5, discontinuities=None)
        self.play(Create(axes), run_time=1.0)
        self.play(Create(curve), run_time=2.0)
        used += 3.0
        if s.get("label"):
            label = MathTex(s["label"], color=SKY).scale(0.7)
            label.align_to(axes, UP).align_to(axes, RIGHT)
            self.play(FadeIn(label), run_time=0.5)
            used += 0.5

        points = s.get("points", [])
        slot = max(1.0, (seconds - used) / max(1, len(points)))
        for p in points:
            pos = axes.c2p(p["x"], p["y"])
            dot = Dot(pos, color=PURPLE, radius=0.09)
            tangent = DashedLine(axes.c2p(p["x"] - 0.7, p["y"]), axes.c2p(p["x"] + 0.7, p["y"]),
                                 color=YELLOW, stroke_width=4)
            # Put the label above a maximum and below a minimum.
            above = p["y"] >= float(f(p["x"] - 0.5))
            lab = MathTex(p.get("label", ""), color=PURPLE).scale(0.6)
            lab.next_to(dot, UP if above else DOWN, buff=0.3)
            self.play(GrowFromCenter(dot), Flash(dot, color=PURPLE), run_time=0.8)
            self.play(Create(tangent), FadeIn(lab), run_time=0.8)
            self.wait(max(0, slot - 1.6))
            used += slot
        return used


def render(lesson_path, out_path, tts_backend="espeak", quality="m",
           voice_model=None, voice_dir=None):
    with open(lesson_path, encoding="utf-8") as fh:
        lesson = validate_lesson(json.load(fh))

    work = tempfile.mkdtemp(prefix="lesson_")
    audio = []
    for i, scene in enumerate(lesson["scenes"]):
        wav = os.path.join(work, f"scene_{i:02d}.wav")
        seconds = synthesize(scene["narration"], lesson["language"], wav, tts_backend,
                             voice_model=voice_model, voice_dir=voice_dir, scene_index=i)
        audio.append((wav, seconds))
        print(f"scene {i} ({scene['type']}): {seconds:.1f}s narration")

    LessonScene.lesson = lesson
    LessonScene.audio = audio
    with tempconfig({
        "quality": QUALITY[quality],
        "media_dir": os.path.join(work, "media"),
        "output_file": "lesson",
        "disable_caching": True,
        "verbosity": "WARNING",
        "progress_bar": "none",
    }):
        scene = LessonScene()
        scene.render()
        produced = str(scene.renderer.file_writer.movie_file_path)

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    shutil.copy(produced, out_path)
    shutil.rmtree(work, ignore_errors=True)
    print(f"saved {out_path}")
    return out_path


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("lesson")
    ap.add_argument("--out", default=None)
    ap.add_argument("--tts", choices=["espeak", "piper", "recorded", "azure"], default="espeak")
    ap.add_argument("--voice-model", help="Piper .onnx voice (with --tts piper)")
    ap.add_argument("--voice-dir", help="folder with scene_00.*, scene_01.* ... (with --tts recorded)")
    ap.add_argument("--quality", choices=list(QUALITY), default="m")
    a = ap.parse_args()
    out = a.out or os.path.splitext(os.path.basename(a.lesson))[0] + ".mp4"
    render(a.lesson, out, a.tts, a.quality, a.voice_model, a.voice_dir)


if __name__ == "__main__":
    main()
