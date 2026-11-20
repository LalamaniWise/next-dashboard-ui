"""Lesson format shared by the script writer (LLM) and the renderer.

A lesson is JSON with a list of scenes. Every scene has `narration` (what the
voice says, written out in words, e.g. "x squared") plus visuals for its type:

  title    heading, subheading
  bullets  heading, bullets[]            (LaTeX text mode; inline maths in $...$)
  steps    heading, lines[]              (each line is LaTeX maths, shown one by one)
  graph    heading, function, label, x_range[min,max,step], y_range[...],
           points[{x, y, label}],        (function uses Python syntax: x**2 - 3*x)
           asymptotes{x[], y[]}          (optional, drawn as labelled dashed lines)

Headings are plain text: LaTeX only works in bullets, lines and graph labels.
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


# Symbols LaTeX cannot read directly, and what to write instead (in maths mode)
SYMBOLS = {
    "≥": r"\geq", "≤": r"\leq", "≠": r"\neq", "≈": r"\approx", "→": r"\rightarrow",
    "←": r"\leftarrow", "⇒": r"\Rightarrow", "×": r"\times", "÷": r"\div", "±": r"\pm",
    "−": "-", "·": r"\cdot", "°": r"^{\circ}", "²": "^{2}", "³": "^{3}", "∞": r"\infty",
    "π": r"\pi", "θ": r"\theta", "α": r"\alpha", "β": r"\beta", "Δ": r"\Delta",
}

# TeX commands that reach files or redefine things. Lessons can be written from
# an uploaded file, so its text must never get to run any of these. ^^ is TeX's
# way of spelling any character, including the backslash.
_FORBIDDEN_TEX = re.compile(
    r"\^\^|filecontents"
    r"|\\(?:input|include|verbatim|lstinput|pdf)[a-zA-Z]*"
    r"|\\(?:usepackage|RequirePackage|documentclass|openin|openout|read|readline|write"
    r"|immediate|newread|newwrite|catcode|def|edef|gdef|xdef|let|futurelet|csname"
    r"|expandafter|special|directlua|newcommand|renewcommand|providecommand|loop"
    r"|jobname|shipout)(?![a-zA-Z])"
)

# A curve must show on at least this share of its x range
MIN_VISIBLE = 0.05
# A point counts as a turning point if the curve looks flat there on the axes
FLAT_SLOPE = 0.05


class LessonError(ValueError):
    pass


def check_function(expr: str) -> str:
    if not isinstance(expr, str) or not expr.strip():
        raise LessonError("graph.function must be a non-empty string")
    if not _ALLOWED_FUNCTION.match(expr):
        raise LessonError(f"graph.function contains unsupported tokens: {expr!r}")
    return expr


def make_function(expr: str):
    """Turn a checked expression into f(x). Undefined values come back as
    inf or nan instead of raising, so x may be a number or an array."""
    import numpy as np
    import sympy

    check_function(expr)
    x = sympy.Symbol("x")
    fn = sympy.lambdify(x, sympy.sympify(expr, locals={"x": x}), "numpy")

    def call(value):
        with np.errstate(all="ignore"):
            return np.asarray(fn(np.asarray(value, dtype=float)), dtype=float)
    return call


def curve_pieces(scene: dict, samples: int = 1000) -> list:
    """The parts of a graph's curve that fit on its axes, as [(xs, ys)].

    The curve is cut wherever it is undefined, leaves the y range or jumps
    across an asymptote."""
    import numpy as np

    y_min, y_max = scene["y_range"][:2]
    xs = np.linspace(scene["x_range"][0], scene["x_range"][1], samples)
    ys = np.broadcast_to(make_function(scene["function"])(xs), xs.shape)
    with np.errstate(all="ignore"):
        shown = np.isfinite(ys) & (ys >= y_min) & (ys <= y_max)
        jumps = np.abs(np.diff(ys)) > (y_max - y_min) / 2
    cuts = np.flatnonzero(~(shown[:-1] & shown[1:]) | jumps) + 1
    runs = np.split(np.arange(samples), cuts)
    return [(xs[run], ys[run]) for run in runs if len(run) >= 2]


def is_turning_point(scene: dict, x: float) -> bool:
    """True if the curve is flat at x, so a horizontal tangent is correct."""
    f = make_function(scene["function"])
    h = 1e-4
    slope = (f(x + h) - f(x - h)) / (2 * h)
    x_min, x_max = scene["x_range"][:2]
    y_min, y_max = scene["y_range"][:2]
    return bool(abs(slope) <= FLAT_SLOPE * (y_max - y_min) / (x_max - x_min))


def _check_braces(tex: str) -> str:
    depth = 0
    for ch in re.sub(r"\\[{}]", "", tex):
        depth += (ch == "{") - (ch == "}")
        if depth < 0:
            break
    if depth:
        raise LessonError(f"unbalanced braces in {tex!r}")
    return tex


def _check_commands(tex: str) -> str:
    bad = _FORBIDDEN_TEX.search(tex)
    if bad:
        raise LessonError(f"{bad.group()!r} is not allowed in {tex!r}")
    return tex


def _clean_text_mode(text: str) -> str:
    text = re.sub(r"(?<!\\)([%&#_])", r"\\\1", text.replace("ŉ", "'n"))
    text = re.sub(r"(?<!\\)\^", r"\\^{}", text)
    for symbol, tex in SYMBOLS.items():
        text = text.replace(symbol, f"${tex}$")
    bad = re.search(r"[^\x00-\x7f\u00c0-\u00ff‘’“”–—…]", text)
    if bad:
        raise LessonError(f"unsupported character {bad.group()!r} in {text!r}")
    return text


def _clean_maths_mode(tex: str) -> str:
    for symbol, replacement in SYMBOLS.items():
        tex = tex.replace(symbol, replacement + " ")
    tex = tex.replace("–", "-").replace("—", "-").replace("’", "'")
    # Each line is set on its own, so an alignment & has no job to do
    tex = re.sub(r"(?<!\\)&", "", tex)
    tex = re.sub(r"(?<!\\)([%#])", r"\\\1", tex)
    bad = re.search(r"[^\x00-\x7f]", tex)
    if bad:
        raise LessonError(f"unsupported character {bad.group()!r} in {tex!r}")
    return tex


def _clean_maths_parts(tex: str) -> str:
    parts = re.split(r"\\text\{([^{}]*)\}", tex)
    return "".join(rf"\text{{{_clean_text_mode(p)}}}" if i % 2 else _clean_maths_mode(p)
                   for i, p in enumerate(parts))


def clean_maths(tex: str) -> str:
    """Make a line of LaTeX maths safe to compile."""
    return _check_braces(_clean_maths_parts(_check_commands(tex)))


def clean_bullet(text: str) -> str:
    """Make a bullet (LaTeX text with $...$ maths) safe to compile."""
    parts = re.split(r"(?<!\\)\$", _check_commands(text))
    if len(parts) % 2 == 0:
        raise LessonError(f"unmatched $ in {text!r}")
    return _check_braces("".join(f"${_clean_maths_parts(p)}$" if i % 2 else _clean_text_mode(p)
                                 for i, p in enumerate(parts)))


def _check_latex(scene: dict) -> None:
    for field in ("heading", "subheading"):
        if re.search(r"[$\\]", scene.get(field, "")):
            raise LessonError(f"{field} must be plain text without LaTeX: {scene[field]!r}")
    for bullet in scene.get("bullets", []):
        clean_bullet(bullet)
    for line in scene.get("lines", []):
        clean_maths(line)
    if scene["type"] == "graph":
        clean_maths(scene.get("label", ""))
        for p in scene.get("points", []):
            clean_maths(p.get("label", ""))


def validate_lesson(lesson: dict) -> dict:
    for key in ("title", "subject", "grade", "language", "scenes"):
        if key not in lesson:
            raise LessonError(f"lesson is missing '{key}'")
    if lesson["language"] not in LANGUAGES:
        raise LessonError(f"language must be one of {sorted(LANGUAGES)}")
    # The cover's topic and subtopic: short labels, optional in older lessons
    for key, limit in (("topic", 80), ("subtopic", 120)):
        value = lesson.get(key)
        if value is not None and (not isinstance(value, str) or len(value) > limit):
            raise LessonError(f"'{key}' must be short text (at most {limit} characters)")
    if not isinstance(lesson["scenes"], list) or not lesson["scenes"]:
        raise LessonError("lesson.scenes must be a non-empty list")

    for i, scene in enumerate(lesson["scenes"]):
        kind = scene.get("type")
        if kind not in SCENE_FIELDS:
            raise LessonError(f"scene {i}: unknown type {kind!r}")
        for field in SCENE_FIELDS[kind]:
            if field not in scene or scene[field] in ("", [], None):
                raise LessonError(f"scene {i} ({kind}): missing '{field}'")
        try:
            _check_latex(scene)
        except LessonError as err:
            raise LessonError(f"scene {i} ({kind}): {err}") from err
        if kind == "graph":
            check_function(scene["function"])
            for rng in ("x_range", "y_range"):
                r = scene[rng]
                if not (isinstance(r, list) and len(r) == 3 and r[0] < r[1] and r[2] > 0):
                    raise LessonError(f"scene {i}: {rng} must be [min, max, step]")
            verify_graph_points(scene, i)
            verify_asymptotes(scene, i)
            visible = sum(len(xs) for xs, _ in curve_pieces(scene, 1000))
            if visible < MIN_VISIBLE * 1000:
                raise LessonError(f"scene {i}: the curve is almost entirely outside "
                                  "x_range and y_range; choose ranges that show it")
    return lesson


def vertical_asymptotes(scene: dict, samples: int = 1000) -> list:
    """Roughly where the curve shoots off to infinity within its x range."""
    import numpy as np

    f = make_function(scene["function"])
    y_span = scene["y_range"][1] - scene["y_range"][0]
    xs = np.linspace(scene["x_range"][0], scene["x_range"][1], samples)
    ys = np.broadcast_to(f(xs), xs.shape)
    size = np.nan_to_num(np.abs(ys), nan=0.0, posinf=np.inf)
    found = [xs[i] for i in (0, -1) if np.isinf(ys[i])]

    # Sharp spikes, as in 1/x
    for i in range(5, samples - 5):
        if (size[i] > y_span and size[i] >= max(size[i - 1], size[i + 1])
                and size[i] > 3 * max(size[i - 5], size[i + 5])):
            found.append(xs[i])

    # Edges of the domain where the curve keeps growing, as in log(x)
    defined = np.isfinite(ys)
    for i in np.flatnonzero(defined[:-1] != defined[1:]):
        bad, good = (xs[i], xs[i + 1]) if defined[i + 1] else (xs[i + 1], xs[i])
        for _ in range(50):
            middle = (bad + good) / 2
            if np.isfinite(f(middle)):
                good = middle
            else:
                bad = middle
        side = 1 if good > bad else -1
        if abs(f(good + side * 1e-9)) - abs(f(good + side * 1e-3)) > 5:
            found.append(good)
    return [float(x) for x in found]


def verify_asymptotes(scene: dict, index: int = 0) -> None:
    """Reject asymptotes that are off the axes or that the curve does not have,
    and curves whose vertical asymptotes are not listed."""
    import numpy as np

    lines = scene.get("asymptotes") or {}
    f = make_function(scene["function"])
    x_min, x_max = scene["x_range"][:2]
    y_min, y_max = scene["y_range"][:2]
    y_span = y_max - y_min
    for x in lines.get("x", []):
        if not x_min <= x <= x_max:
            raise LessonError(f"scene {index}: asymptote x = {x} is outside x_range")
        near = f(np.array([x - 1e-3, x + 1e-3]))
        if not np.isinf(f(x)) and not np.any(np.abs(near) > 10 * y_span):
            raise LessonError(f"scene {index}: x = {x} is not an asymptote of the curve")
    for y in lines.get("y", []):
        if not y_min <= y <= y_max:
            raise LessonError(f"scene {index}: asymptote y = {y} is outside y_range")
        with np.errstate(all="ignore"):
            gaps = np.abs(f(np.array([-1e6, 1e6])) - y)
        if not np.any(gaps < 0.01 * y_span):
            raise LessonError(f"scene {index}: y = {y} is not an asymptote of the curve")
    tolerance = (x_max - x_min) / 100
    for x in vertical_asymptotes(scene):
        if not any(abs(x - listed) <= tolerance for listed in lines.get("x", [])):
            raise LessonError(f"scene {index}: the curve has a vertical asymptote near "
                              f"x = {x:.2f}; list it in asymptotes.x")


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
        try:
            actual = float(f.subs(x, p["x"]))
        except TypeError:  # undefined there, e.g. 1/x at x = 0
            raise LessonError(f"scene {index}: the curve is undefined at x = {p['x']}") from None
        if abs(actual - p["y"]) > 0.01 * y_span + 1e-9:
            raise LessonError(
                f"scene {index}: point ({p['x']}; {p['y']}) is not on the curve, "
                f"f({p['x']}) = {actual:g}"
            )
