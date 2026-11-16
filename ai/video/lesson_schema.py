"""Lesson format shared by the script writer (LLM) and the renderer.

A lesson is JSON with a list of scenes. Every scene has `narration` (what the
voice says, written out in words, e.g. "x squared") plus visuals for its type:

  title    heading, subheading
  bullets  heading, bullets[]            (LaTeX text mode; inline maths in $...$)
  steps    heading, lines[]              (each line is LaTeX maths, shown one by one)
  graph    heading, function, label, x_range[min,max,step], y_range[...],
           points[{x, y, label}]         (function uses Python syntax: x**2 - 3*x)
"""

import re

SCENE_FIELDS = {
    "title": ["heading", "narration"],
    "bullets": ["heading", "bullets", "narration"],
    "steps": ["heading", "lines", "narration"],
    "graph": ["heading", "function", "x_range", "y_range", "narration"],
}

LANGUAGES = {"en", "af"}

# Only these tokens may appear in a graph function, so text written by an AI
# model can never run arbitrary Python when we turn it into a curve.
_ALLOWED_FUNCTION = re.compile(
    r"^(?:\s|\d|\.|x|\+|-|\*|/|\(|\)|sin|cos|tan|sqrt|exp|log|Abs|pi)*$"
)


class LessonError(ValueError):
    pass


def check_function(expr: str) -> str:
    if not isinstance(expr, str) or not expr.strip():
        raise LessonError("graph.function must be a non-empty string")
    if not _ALLOWED_FUNCTION.match(expr):
        raise LessonError(f"graph.function contains unsupported tokens: {expr!r}")
    return expr


def validate_lesson(lesson: dict) -> dict:
    for key in ("title", "subject", "grade", "language", "scenes"):
        if key not in lesson:
            raise LessonError(f"lesson is missing '{key}'")
    if lesson["language"] not in LANGUAGES:
        raise LessonError(f"language must be one of {sorted(LANGUAGES)}")
    if not isinstance(lesson["scenes"], list) or not lesson["scenes"]:
        raise LessonError("lesson.scenes must be a non-empty list")

    for i, scene in enumerate(lesson["scenes"]):
        kind = scene.get("type")
        if kind not in SCENE_FIELDS:
            raise LessonError(f"scene {i}: unknown type {kind!r}")
        for field in SCENE_FIELDS[kind]:
            if field not in scene or scene[field] in ("", [], None):
                raise LessonError(f"scene {i} ({kind}): missing '{field}'")
        if kind == "graph":
            check_function(scene["function"])
            for rng in ("x_range", "y_range"):
                r = scene[rng]
                if not (isinstance(r, list) and len(r) == 3 and r[0] < r[1] and r[2] > 0):
                    raise LessonError(f"scene {i}: {rng} must be [min, max, step]")
            verify_graph_points(scene, i)
    return lesson


def verify_graph_points(scene: dict, index: int = 0) -> None:
    """Reject graphs whose labelled points are not on the curve.

    AI models sometimes get arithmetic wrong. Checking the numbers here means
    a lesson with a wrong turning point or intercept never reaches a student.
    """
    import sympy

    x = sympy.Symbol("x")
    f = sympy.sympify(check_function(scene["function"]), locals={"x": x})
    y_span = scene["y_range"][1] - scene["y_range"][0]
    for p in scene.get("points", []):
        actual = float(f.subs(x, p["x"]))
        if abs(actual - p["y"]) > 0.01 * y_span + 1e-9:
            raise LessonError(
                f"scene {index}: point ({p['x']}; {p['y']}) is not on the curve, "
                f"f({p['x']}) = {actual:g}"
            )
