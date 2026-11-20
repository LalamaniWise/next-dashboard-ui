import { auth } from "@/lib/auth";
import { LESSON_VIDEO_FILES, LessonVideoFile } from "@/lib/lessonVideoOptions";
import { getJob, JOB_ID, jobFile, VideoServiceError } from "@/lib/videoService";

// Downloads what a video job made. Staff only: the memo holds the answers.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ jobId: string; kind: string }> }
) {
  const { userId, role } = await auth();
  if (!userId) return new Response("Please sign in.", { status: 401 });
  if (role !== "admin" && role !== "teacher") return new Response("Not found.", { status: 404 });

  const { jobId, kind } = await params;
  if (!JOB_ID.test(jobId) || !Object.hasOwn(LESSON_VIDEO_FILES, kind)) {
    return new Response("Not found.", { status: 404 });
  }
  const file = LESSON_VIDEO_FILES[kind as LessonVideoFile];

  try {
    const [job, res] = await Promise.all([getJob(jobId), jobFile(jobId, kind as LessonVideoFile)]);
    const slug = (job.title ?? "lesson").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
    return new Response(res.body, {
      headers: {
        "Content-Type": file.type,
        ...(res.headers.get("content-length") && { "Content-Length": res.headers.get("content-length")! }),
        "Content-Disposition": `attachment; filename="${slug || "lesson"}-${file.suffix}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    if (!(err instanceof VideoServiceError)) console.log(err);
    return new Response("That file isn't available.", { status: 404 });
  }
}
