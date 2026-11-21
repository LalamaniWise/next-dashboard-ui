import "server-only";
import { ImageResponse } from "next/og";
import { BRAND_BLUE, BRAND_YELLOW, loadFont, loadLogo, logoDataUrl } from "./brandAssets";
import { LESSON_VIDEO_HANDLE } from "./lessonVideoOptions";

// A lesson video's cover (1280x720): logo, subject, topic, subtopic and
// grades. ai/video/cover.py draws the same design for the video's opening
// screen and its YouTube thumbnail, so keep the two in step.

export type CoverInfo = {
  school: string;
  subject: string;
  grades: string;
  topic: string;
  subtopic?: string | null;
};

const INK = "#111827";

// Long topics get a smaller size so they still fit in three lines
const topicSize = (text: string) => (text.length > 70 ? 46 : text.length > 40 ? 56 : 68);

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

export const coverImage = async (info: CoverInfo) => {
  const [logo, regular, semibold, extrabold] = await Promise.all([
    loadLogo(),
    loadFont("Regular"),
    loadFont("SemiBold"),
    loadFont("ExtraBold"),
  ]);
  const topic = clip(info.topic.trim(), 110);
  const subtopic = info.subtopic?.trim() ? clip(info.subtopic.trim(), 70) : null;

  return new ImageResponse(
    (
      <div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", background: "#ffffff", fontFamily: "Inter" }}>
        <div style={{ display: "flex", flex: 1 }}>
          <div style={{ display: "flex", width: 470, alignItems: "center", justifyContent: "center" }}>
            {logo && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoDataUrl(logo)} alt="" width={390} height={390} style={{ objectFit: "contain" }} />
            )}
          </div>
          <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", flex: 1, padding: "40px 64px 40px 8px" }}>
            <div style={{ display: "flex" }}>
              <span style={{ background: BRAND_BLUE, color: "#fff", fontSize: 30, fontWeight: 600, padding: "10px 24px", borderRadius: 999 }}>
                {clip(info.subject, 40)}
              </span>
            </div>
            <div style={{ display: "flex", marginTop: 28, fontSize: topicSize(topic), fontWeight: 800, color: INK, lineHeight: 1.1 }}>
              {topic}
            </div>
            {subtopic && (
              <div style={{ display: "flex", marginTop: 18, fontSize: 40, fontWeight: 600, color: BRAND_BLUE, lineHeight: 1.2 }}>
                {subtopic}
              </div>
            )}
            <div style={{ display: "flex", marginTop: 34 }}>
              <span style={{ background: BRAND_YELLOW, color: INK, fontSize: 32, fontWeight: 800, padding: "10px 26px", borderRadius: 999 }}>
                {info.grades}
              </span>
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", height: 72, background: INK, padding: "0 40px", gap: 14 }}>
          <div style={{ display: "flex", width: 22, height: 22, background: BRAND_YELLOW }} />
          <div style={{ display: "flex", width: 22, height: 22, background: BRAND_BLUE }} />
          <span style={{ color: "#fff", fontSize: 26, fontWeight: 400, marginLeft: 8 }}>
            {clip(info.school, LESSON_VIDEO_HANDLE ? 40 : 60)} · Lesson video
          </span>
          {LESSON_VIDEO_HANDLE && (
            <span style={{ color: BRAND_YELLOW, fontSize: 26, fontWeight: 600, marginLeft: "auto" }}>
              Follow {LESSON_VIDEO_HANDLE}
            </span>
          )}
        </div>
      </div>
    ),
    {
      width: 1280,
      height: 720,
      fonts: [
        { name: "Inter", data: regular, weight: 400, style: "normal" },
        { name: "Inter", data: semibold, weight: 600, style: "normal" },
        { name: "Inter", data: extrabold, weight: 800, style: "normal" },
      ],
    }
  );
};
