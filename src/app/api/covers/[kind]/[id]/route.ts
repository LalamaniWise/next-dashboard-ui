import { auth } from "@/lib/auth";
import { gradesLabel } from "@/lib/brandAssets";
import { CoverInfo, coverImage } from "@/lib/coverImage";
import { materialAccessWhere } from "@/lib/materials";
import prisma from "@/lib/prisma";
import { getSettings } from "@/lib/schoolSettings";
import { videoGradesFor } from "@/lib/videoService";

// Cover pictures for lesson videos (kind "video"), videos in a playlist
// ("playlist-video") and playlists ("playlist"). Only for people who may see
// the video, the same as the video lists.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ kind: string; id: string }> }
) {
  const notFound = () => new Response("Not found.", { status: 404 });
  const { userId, role } = await auth();
  if (!userId) return new Response("Please sign in.", { status: 401 });

  const { kind, id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) return notFound();
  const school = (await getSettings()).schoolName;

  let info: CoverInfo | null = null;

  if (kind === "video") {
    const video = await prisma.video.findUnique({
      where: { id },
      include: { grades: { select: { level: true } } },
    });
    if (!video) return notFound();
    const allowed = await videoGradesFor(role, userId);
    if (allowed !== null) {
      const visible = video.status === "PUBLISHED" && video.grades.some((g) => allowed.includes(g.level));
      if (!visible) return notFound();
    }
    const levels = video.grades.length ? video.grades.map((g) => g.level) : [video.grade];
    info = {
      school,
      subject: video.subjectName,
      grades: gradesLabel(levels),
      topic: video.topic || video.title,
      subtopic: video.subtopic || null,
    };
  } else if (kind === "playlist" || kind === "playlist-video") {
    const access = await materialAccessWhere(role, userId);
    if (!access) return notFound();
    const video =
      kind === "playlist-video" ? await prisma.playlistVideo.findUnique({ where: { id } }) : null;
    if (kind === "playlist-video" && !video) return notFound();
    const playlist = await prisma.playlist.findFirst({
      where: { AND: [{ id: video ? video.playlistId : id }, access] },
      include: { subject: { select: { name: true } }, grade: { select: { level: true } }, _count: { select: { videos: true } } },
    });
    if (!playlist) return notFound();
    info = {
      school,
      subject: playlist.subject.name,
      grades: gradesLabel(playlist.grade ? [playlist.grade.level] : []),
      topic: playlist.title,
      subtopic: video
        ? video.title
        : `${playlist._count.videos} video${playlist._count.videos === 1 ? "" : "s"}`,
    };
  } else {
    return notFound();
  }

  const image = await coverImage(info);
  const headers = new Headers(image.headers);
  headers.set("Cache-Control", "private, max-age=600");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(image.body, { status: 200, headers });
}
