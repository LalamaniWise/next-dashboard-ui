"""A lesson video's cover: school logo, subject, topic, subtopic and grades.

The same picture is the first seconds of the video and its YouTube thumbnail.
src/lib/coverImage.tsx draws this design for the app's video lists, so keep
the two in step.

    python cover.py --subject Mathematics --grade 12 --topic "Differential calculus" \\
        --subtopic "Stationary points" --out cover.jpg
    python cover.py ... --video lesson.mp4 --out lesson-with-cover.mp4
"""

import argparse
import os
import shutil
import subprocess
import tempfile

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", ".."))
DEFAULT_LOGO = os.path.join(REPO, "public", "logo.png")
FONT_DIR = os.path.join(REPO, "assets", "fonts")
DEFAULT_SCHOOL = "Capital Mathematics Studies"

W, H = 1280, 720
INK = (17, 24, 39)
YELLOW = (255, 205, 3)
BLUE = (0, 122, 199)
WHITE = (255, 255, 255)
COVER_SECONDS = 3.0
GRADE_WORD = {"en": ("Grade", "Grades"), "af": ("Graad", "Grade")}
LABEL = {"en": "Lesson video", "af": "Lesvideo"}


def font(weight, size):
    for path in (os.path.join(FONT_DIR, f"Inter-{weight}.otf"),
                 "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
                 r"C:\Windows\Fonts\arialbd.ttf"):
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def grades_label(levels, language="en"):
    one, many = GRADE_WORD.get(language, GRADE_WORD["en"])
    g = sorted(set(int(x) for x in levels))
    if not g:
        return "All grades" if language == "en" else "Alle grade"
    if len(g) == 1:
        return f"{one} {g[0]}"
    if len(g) > 2 and all(b == a + 1 for a, b in zip(g, g[1:])):
        return f"{many} {g[0]}–{g[-1]}"
    return f"{many} {', '.join(map(str, g[:-1]))} & {g[-1]}"


def wrap(draw, text, fnt, width, max_lines):
    words, lines, cur = text.split(), [], ""
    for w in words:
        trial = f"{cur} {w}".strip()
        if draw.textlength(trial, font=fnt) <= width or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = w
    lines.append(cur)
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        while draw.textlength(lines[-1] + "…", font=fnt) > width and " " in lines[-1]:
            lines[-1] = lines[-1].rsplit(" ", 1)[0]
        lines[-1] += "…"
    return lines


def pill(draw, x, y, text, fnt, fill, ink, pad_x=26, pad_y=12):
    w = draw.textlength(text, font=fnt)
    top, bottom = fnt.getbbox("Hg")[1], fnt.getbbox("Hg")[3]
    h = bottom - top + pad_y * 2
    draw.rounded_rectangle((x, y, x + w + pad_x * 2, y + h), radius=h // 2, fill=fill)
    draw.text((x + pad_x, y + pad_y - top), text, font=fnt, fill=ink)
    return h


def make_cover(details, out_path, logo_path=None, school=None):
    """details: subject, grades (list of numbers), topic, subtopic (optional),
    language. Writes a 1280x720 JPG (YouTube thumbnails must be under 2 MB)."""
    img = Image.new("RGB", (W, H), WHITE)
    d = ImageDraw.Draw(img)
    language = details.get("language", "en")

    logo_path = logo_path if logo_path and os.path.exists(logo_path) else DEFAULT_LOGO
    if os.path.exists(logo_path):
        logo = Image.open(logo_path).convert("RGBA")
        logo.thumbnail((390, 390), Image.LANCZOS)
        img.paste(logo, ((470 - logo.width) // 2, (H - 72 - logo.height) // 2), logo)

    x, right = 478, W - 64
    topic = " ".join(str(details.get("topic") or details["subject"]).split())
    size = 46 if len(topic) > 70 else 56 if len(topic) > 40 else 68
    f_topic = font("ExtraBold", size)
    topic_lines = wrap(d, topic, f_topic, right - x, 3)
    subtopic = " ".join(str(details.get("subtopic") or "").split())
    f_sub = font("SemiBold", 40)
    sub_lines = wrap(d, subtopic, f_sub, right - x, 2) if subtopic else []
    f_pill, f_grade = font("SemiBold", 30), font("ExtraBold", 32)

    # Measure, then centre the block vertically above the bottom bar
    line_t, line_s = int(size * 1.1), 48
    block = 56 + 28 + len(topic_lines) * line_t + (18 + len(sub_lines) * line_s if sub_lines else 0) + 34 + 58
    y = max(30, (H - 72 - block) // 2)
    y += pill(d, x, y, details["subject"][:40], f_pill, BLUE, WHITE, 24, 10) + 28
    for line in topic_lines:
        d.text((x, y), line, font=f_topic, fill=INK)
        y += line_t
    if sub_lines:
        y += 18
        for line in sub_lines:
            d.text((x, y), line, font=f_sub, fill=BLUE)
            y += line_s
    y += 34
    pill(d, x, y, grades_label(details.get("grades") or [], language), f_grade, YELLOW, INK)

    d.rectangle((0, H - 72, W, H), fill=INK)
    d.rectangle((40, H - 47, 62, H - 25), fill=YELLOW)
    d.rectangle((76, H - 47, 98, H - 25), fill=BLUE)
    f_bar = font("Regular", 26)
    bar = f"{(school or DEFAULT_SCHOOL)[:60]} · {LABEL.get(language, LABEL['en'])}"
    d.text((120, H - 36 - (f_bar.getbbox('Hg')[1] + f_bar.getbbox('Hg')[3]) / 2), bar, font=f_bar, fill=WHITE)

    img.save(out_path, "JPEG", quality=90, optimize=True)
    return out_path


def _probe(path, stream, entries):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", stream, "-show_entries",
                          f"stream={entries}", "-of", "csv=p=0", path],
                         capture_output=True, text=True, check=True).stdout.strip().splitlines()
    return out[0].split(",") if out else []


def prepend_cover(video_path, cover_path, out_path, seconds=COVER_SECONDS):
    """Show the cover (silent) for a few seconds before the lesson starts."""
    w, h, rate = _probe(video_path, "v:0", "width,height,r_frame_rate")
    audio = _probe(video_path, "a:0", "sample_rate,channels")
    sample_rate = audio[0] if audio else "44100"
    layout = "mono" if audio and audio[1] == "1" else "stereo"
    tmp = tempfile.mkdtemp(prefix="cover_")
    try:
        out_tmp = os.path.join(tmp, "out.mp4")
        cover_v = (f"[0:v]scale={w}:{h}:force_original_aspect_ratio=decrease,"
                   f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=white,setsar=1,fps={rate},format=yuv420p[cv]")
        main_v = f"[2:v]setsar=1,fps={rate},format=yuv420p[mv]"
        main_a = "[2:a]anull[ma]" if audio else f"anullsrc=r={sample_rate}:cl={layout},atrim=0.01[ma]"
        subprocess.run([
            "ffmpeg", "-nostdin", "-v", "error", "-y",
            "-loop", "1", "-t", str(seconds), "-i", cover_path,
            "-f", "lavfi", "-t", str(seconds), "-i", f"anullsrc=r={sample_rate}:cl={layout}",
            "-i", video_path,
            "-filter_complex", f"{cover_v};{main_v};{main_a};[cv][1:a][mv][ma]concat=n=2:v=1:a=1[v][a]",
            "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
            "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out_tmp,
        ], check=True)
        shutil.move(out_tmp, out_path)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return out_path


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--subject", required=True)
    ap.add_argument("--grade", type=int, action="append", required=True, help="repeat for several grades")
    ap.add_argument("--topic", required=True)
    ap.add_argument("--subtopic")
    ap.add_argument("--language", choices=["en", "af"], default="en")
    ap.add_argument("--logo", help=f"default: {DEFAULT_LOGO}")
    ap.add_argument("--school", default=DEFAULT_SCHOOL)
    ap.add_argument("--video", help="put the cover at the start of this video")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    details = {"subject": a.subject, "grades": a.grade, "topic": a.topic,
               "subtopic": a.subtopic, "language": a.language}
    if a.video:
        with tempfile.TemporaryDirectory() as tmp:
            cover = make_cover(details, os.path.join(tmp, "cover.jpg"), a.logo, a.school)
            prepend_cover(a.video, cover, a.out)
    else:
        make_cover(details, a.out, a.logo, a.school)
    print(f"saved {a.out}")


if __name__ == "__main__":
    main()
