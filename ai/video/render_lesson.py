"""Render a lesson JSON file into a narrated MP4.

    python render_lesson.py lessons/gr12-maths-stationary-points.json
    python render_lesson.py lesson.json --board black --out video.mp4
    python render_lesson.py lesson.json --tts azure --quality h --out video.mp4
    python render_lesson.py lesson.json --tts recorded --voice-dir recordings/lesson1
    python render_lesson.py lesson.json --tts piper --voice-model my-voice.onnx

The lesson is written on a whiteboard (--board white) or a chalkboard
(--board black) while a stick-man teacher talks and points with a laser at
each line as it is written.

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

import manimpango
import numpy as np
import sympy
from manim import (
    DOWN, LEFT, RIGHT, UP,
    Arc, Axes, Circle, Create, DashedLine, Dot, Ellipse, FadeIn, FadeOut, Flash, GrowFromCenter,
    Line, MathTex, Rectangle, Scene, Tex, Text, ValueTracker, VGroup, Write,
    always_redraw, config, linear, tempconfig, there_and_back,
)

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from lesson_schema import check_function, validate_lesson  # noqa: E402
from tts import synthesize  # noqa: E402

BOARDS = {
    # Whiteboard: dark marker ink, blue/red/green markers
    "white": {"board": "#FBFBF8", "frame": "#9CA3AF", "ink": "#1F2937", "muted": "#6B7280",
              "accent": "#1D4ED8", "result": "#DC2626", "mark": "#16A34A", "laser": "#EF4444"},
    # Chalkboard: white chalk, pastel coloured chalk
    "black": {"board": "#1E2B24", "frame": "#7C5A3A", "ink": "#F3F4F1", "muted": "#A8B0AA",
              "accent": "#93C5FD", "result": "#FDE047", "mark": "#F9A8D4", "laser": "#F87171"},
}

# First handwriting-style font that is installed; plain sans-serif otherwise
HAND_FONTS = ("Patrick Hand", "Segoe Print", "Ink Free", "Comic Neue", "Comic Sans MS")
FONT = next((f for f in HAND_FONTS if f in set(manimpango.list_fonts())), "sans-serif")

QUALITY = {"l": "low_quality", "m": "medium_quality", "h": "high_quality"}

# Writing area on the left of the board; the teacher stands on the right
AREA_LEFT, AREA_RIGHT = -6.4, 3.4
AREA_CENTER = (AREA_LEFT + AREA_RIGHT) / 2
TEACHER_X, FLOOR_Y = 5.3, -3.55


def fit(mob, max_width):
    if mob.width > max_width:
        mob.scale_to_fit_width(max_width)
    return mob


def make_function(expr: str):
    check_function(expr)
    x = sympy.Symbol("x")
    parsed = sympy.sympify(expr, locals={"x": x})
    return sympy.lambdify(x, parsed, "numpy")


def unit(v):
    n = np.linalg.norm(v)
    return v / n if n else v


class LessonScene(Scene):
    lesson: dict = {}
    audio: list = []  # [(wav_path, seconds)] per scene
    board: str = "white"

    def construct(self):
        self.c = BOARDS[self.board]
        self.camera.background_color = self.c["board"]
        self.max_w = AREA_RIGHT - AREA_LEFT
        self.keep = self.draw_board() + self.draw_teacher()

        for scene, (wav, seconds) in zip(self.lesson["scenes"], self.audio):
            self.add_sound(wav)
            self.talk_until = self.time + seconds
            builder = getattr(self, f"scene_{scene['type']}")
            used = builder(scene, seconds)
            self.lower_laser()
            self.wait(max(0.3, seconds - used) + 0.4)
            content = [m for m in self.mobjects if m not in self.keep]
            if content:
                self.play(*[FadeOut(m) for m in content], run_time=0.5)

    # --- board and teacher ---------------------------------------------------
    def draw_board(self):
        w, h = config.frame_width, config.frame_height
        frame = Rectangle(width=w - 0.15, height=h - 0.15, stroke_color=self.c["frame"],
                          stroke_width=14)
        ledge = Rectangle(width=w - 0.3, height=0.16, fill_color=self.c["frame"], fill_opacity=1,
                          stroke_width=0).move_to([0, -h / 2 + 0.3, 0])
        self.add(frame, ledge)
        return [frame, ledge]

    def draw_teacher(self):
        """A stick man facing the board. His left arm holds a laser pointer
        aimed at self.tip; his right arm can wave. He talks while his
        narration is playing."""
        ink = self.c["ink"]
        feet = np.array([TEACHER_X, FLOOR_Y, 0])
        neck, hip = feet + UP * 2.45, feet + UP * 1.15
        self.shoulder = feet + UP * 2.2
        head_c = feet + UP * 2.8

        # Where the laser points. Invisible itself: laser() draws the dot.
        self.tip = Dot(radius=0.01).set_opacity(0).move_to(self.shoulder + LEFT + DOWN)
        self.beam = ValueTracker(0)   # 0 = laser off and arm down, 1 = pointing
        self.wave = ValueTracker(0)   # angle of the free arm while waving
        self.talk_until = 0

        body = VGroup(
            Circle(radius=0.34, color=ink, stroke_width=6).move_to(head_c),
            Line(neck, hip, color=ink, stroke_width=6),
            Line(hip, feet + LEFT * 0.4, color=ink, stroke_width=6),
            Line(hip, feet + RIGHT * 0.4, color=ink, stroke_width=6),
            Dot(head_c + LEFT * 0.15 + UP * 0.07, radius=0.035, color=ink),
            Dot(head_c + LEFT * 0.01 + UP * 0.07, radius=0.035, color=ink),
        )

        def mouth():
            talking = self.time < self.talk_until
            open_by = 0.03 + (0.07 * abs(np.sin(self.time * 11)) if talking else 0)
            if talking:
                return Ellipse(width=0.14, height=open_by, color=ink, stroke_width=3,
                               fill_color=ink, fill_opacity=1).move_to(head_c + LEFT * 0.08 + DOWN * 0.13)
            return Arc(radius=0.1, start_angle=np.pi * 1.15, angle=np.pi * 0.7, color=ink,
                       stroke_width=3).move_to(head_c + LEFT * 0.08 + DOWN * 0.13)

        def hand():
            # Arm hangs down when the laser is off, points at the tip when on
            rest = self.shoulder + DOWN * 0.95 + LEFT * 0.15
            aim = self.shoulder + unit(self.tip.get_center() - self.shoulder) * 0.95
            b = self.beam.get_value()
            return rest * (1 - b) + aim * b

        def pointing_arm():
            h = hand()
            pointer = unit(h - self.shoulder) * 0.25
            return VGroup(Line(self.shoulder, h, color=ink, stroke_width=6),
                          Line(h, h + pointer, color=self.c["muted"], stroke_width=9))

        def free_arm():
            angle = -np.pi / 2.6 + self.wave.get_value()
            end = self.shoulder + 0.95 * np.array([np.cos(angle), np.sin(angle), 0])
            return Line(self.shoulder, end, color=ink, stroke_width=6)

        def laser():
            b = self.beam.get_value()
            h = hand()
            start = h + unit(h - self.shoulder) * 0.25
            beam = Line(start, self.tip.get_center(), color=self.c["laser"], stroke_width=2,
                        stroke_opacity=0.35 * b)
            glow = Dot(self.tip.get_center(), radius=0.15, color=self.c["laser"], fill_opacity=0.25 * b)
            dot = Dot(self.tip.get_center(), radius=0.06, color=self.c["laser"], fill_opacity=b)
            return VGroup(beam, glow, dot)

        parts = [body, always_redraw(mouth), always_redraw(pointing_arm), always_redraw(free_arm),
                 always_redraw(laser)]
        self.add(*parts)
        return parts + [self.tip]

    def point_at(self, where, run_time=0.4):
        self.play(self.tip.animate.move_to(where), self.beam.animate.set_value(1), run_time=run_time)

    def lower_laser(self):
        if self.beam.get_value() > 0:
            self.play(self.beam.animate.set_value(0), run_time=0.3)

    def wave_hello(self):
        self.play(self.wave.animate.set_value(np.pi * 0.9), run_time=0.4)
        for _ in range(2):
            self.play(self.wave.animate.set_value(np.pi * 0.7), run_time=0.25, rate_func=there_and_back)
        self.play(self.wave.animate.set_value(0), run_time=0.4)
        return 1.3

    # --- helpers -------------------------------------------------------------
    def text(self, words, scale, color=None, bold=False):
        return Text(words, font=FONT, weight="BOLD" if bold else "NORMAL",
                    color=color or self.c["ink"]).scale(scale)

    def heading(self, words):
        h = fit(self.text(words, 0.7, bold=True), self.max_w)
        h.to_edge(UP, buff=0.5).set_x(AREA_LEFT + h.width / 2)
        bar = Line(LEFT, RIGHT, color=self.c["accent"], stroke_width=6)
        bar.set_width(min(h.width, 3)).next_to(h, DOWN, buff=0.15).align_to(h, LEFT)
        self.play(Write(h), Create(bar), run_time=1.0)
        return VGroup(h, bar), 1.0

    def write_along(self, item, run_time):
        """Write an item while the laser runs along it, left to right."""
        self.point_at(item.get_left(), run_time=0.3)
        self.play(Write(item), self.tip.animate.move_to(item.get_right()),
                  run_time=run_time, rate_func=linear)
        return 0.3 + run_time

    def reveal(self, items, seconds, used):
        """Write items one at a time, spread evenly over the narration."""
        slot = max(1.0, (seconds - used) / max(1, len(items)))
        for item in items:
            spent = self.write_along(item, min(2.5, slot * 0.6))
            self.wait(max(0, slot - spent))
            used += slot
        return used

    # --- scene types ---------------------------------------------------------
    def scene_title(self, s, seconds):
        title = fit(self.text(s["heading"], 0.95, bold=True), self.max_w)
        sub = fit(self.text(s.get("subheading", ""), 0.5, self.c["muted"]), self.max_w)
        sub.next_to(title, DOWN, buff=0.4)
        line = Line(LEFT * 2, RIGHT * 2, color=self.c["result"], stroke_width=8).next_to(sub, DOWN, buff=0.4)
        VGroup(title, sub, line).move_to([AREA_CENTER, 0.3, 0])
        used = self.wave_hello()
        self.play(Write(title), run_time=1.5)
        self.play(Write(sub), GrowFromCenter(line), run_time=1.0)
        return used + 2.5

    def scene_bullets(self, s, seconds):
        head, used = self.heading(s["heading"])
        # Shrink the rows together so they all stay the same size
        # \textbullet draws nothing with the default fonts, so use the maths bullet
        rows = VGroup(*[Tex(r"$\bullet$\ " + b, color=self.c["ink"], tex_environment="flushleft")
                        for b in s["bullets"]]).arrange(DOWN, aligned_edge=LEFT, buff=0.5)
        fit(rows, self.max_w - 0.3)
        if rows.height > config.frame_height - 2.8:
            rows.scale_to_fit_height(config.frame_height - 2.8)
        rows.next_to(head, DOWN, buff=0.7).set_x(AREA_LEFT + rows.width / 2)
        return self.reveal(list(rows), seconds, used)

    def scene_steps(self, s, seconds):
        head, used = self.heading(s["heading"])
        lines = VGroup(*[MathTex(line, color=self.c["ink"]).scale(1.15) for line in s["lines"]])
        lines.arrange(DOWN, aligned_edge=LEFT, buff=0.45)
        fit(lines, self.max_w - 0.3)
        if lines.height > config.frame_height - 2.8:
            lines.scale_to_fit_height(config.frame_height - 2.8)
        lines.next_to(head, DOWN, buff=0.6).set_x(AREA_LEFT + lines.width / 2)
        # The last line is the result: give it a highlight colour.
        lines[-1].set_color(self.c["result"])
        return self.reveal(list(lines), seconds, used)

    def scene_graph(self, s, seconds):
        head, used = self.heading(s["heading"])
        f = make_function(s["function"])
        xr, yr = s["x_range"], s["y_range"]
        axes = Axes(
            x_range=xr, y_range=yr, x_length=8, y_length=5.2,
            axis_config={"color": self.c["muted"], "include_numbers": True, "font_size": 22,
                         "decimal_number_config": {"color": self.c["muted"], "num_decimal_places": 0}},
            tips=False,
        ).next_to(head, DOWN, buff=0.35).set_x(AREA_CENTER)
        curve = axes.plot(lambda t: float(f(t)), x_range=[xr[0], xr[1]], color=self.c["accent"],
                          stroke_width=5, discontinuities=None)
        self.play(Create(axes), run_time=1.0)
        # The laser traces the curve as it is drawn
        self.point_at(curve.get_start(), run_time=0.3)
        self.play(Create(curve), self.tip.animate.move_to(curve.get_end()), run_time=2.0, rate_func=linear)
        used += 3.3
        if s.get("label"):
            label = MathTex(s["label"], color=self.c["accent"]).scale(0.7)
            label.align_to(axes, UP).align_to(axes, RIGHT)
            self.play(FadeIn(label), run_time=0.5)
            used += 0.5

        points = s.get("points", [])
        slot = max(1.4, (seconds - used) / max(1, len(points)))
        for p in points:
            pos = axes.c2p(p["x"], p["y"])
            self.point_at(pos, run_time=0.4)
            dot = Dot(pos, color=self.c["result"], radius=0.09)
            tangent = DashedLine(axes.c2p(p["x"] - 0.7, p["y"]), axes.c2p(p["x"] + 0.7, p["y"]),
                                 color=self.c["mark"], stroke_width=4)
            # Put the label above a maximum and below a minimum.
            above = p["y"] >= float(f(p["x"] - 0.5))
            lab = MathTex(p.get("label", ""), color=self.c["result"]).scale(0.6)
            lab.next_to(dot, UP if above else DOWN, buff=0.3)
            self.play(GrowFromCenter(dot), Flash(dot, color=self.c["result"]), run_time=0.8)
            self.play(Create(tangent), Write(lab), run_time=0.8)
            self.wait(max(0, slot - 2.0))
            used += slot
        return used


def render(lesson_path, out_path, tts_backend="espeak", quality="m",
           voice_model=None, voice_dir=None, board="white"):
    if board not in BOARDS:
        raise ValueError(f"board must be one of {', '.join(BOARDS)}")
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
    LessonScene.board = board
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
    ap.add_argument("--board", choices=list(BOARDS), default="white",
                    help="white = whiteboard, black = chalkboard")
    ap.add_argument("--tts", choices=["espeak", "piper", "recorded", "azure"], default="espeak")
    ap.add_argument("--voice-model", help="Piper .onnx voice (with --tts piper)")
    ap.add_argument("--voice-dir", help="folder with scene_00.*, scene_01.* ... (with --tts recorded)")
    ap.add_argument("--quality", choices=list(QUALITY), default="m")
    a = ap.parse_args()
    out = a.out or os.path.splitext(os.path.basename(a.lesson))[0] + ".mp4"
    render(a.lesson, out, a.tts, a.quality, a.voice_model, a.voice_dir, a.board)


if __name__ == "__main__":
    main()
