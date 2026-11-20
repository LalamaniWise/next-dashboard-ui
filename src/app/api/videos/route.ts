import path from "path";
import { auth } from "@/lib/auth";
import { lessonVideoSchema } from "@/lib/formValidationSchemas";
import { LESSON_SOURCE_TYPES, MAX_LESSON_SOURCE_MB } from "@/lib/lessonVideoOptions";
import { blockedFor, recordAttempt } from "@/lib/rateLimit";
import { LessonSource, startJob, VideoServiceError } from "@/lib/videoService";

// Each video costs AI and rendering time, so creating them is limited
const CREATE_LIMIT = 5;
const CREATE_WINDOW_MINUTES = 60;

// A route handler rather than a server action, which caps request bodies at 1 MB
export async function POST(request: Request) {
  const fail = (error: string, status = 400) => Response.json({ error }, { status });

  const { userId, role } = await auth();
  if (!userId || (role !== "admin" && role !== "teacher")) {
    return fail("Only admins and teachers can create videos.", 403);
  }

  const key = `video:create:${userId}`;
  const wait = blockedFor(key, CREATE_LIMIT);
  if (wait) return fail(`You've started ${CREATE_LIMIT} videos this hour. Try again in ${wait} minutes.`, 429);

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > (MAX_LESSON_SOURCE_MB + 1) * 1024 * 1024) {
    return fail(`Files can be at most ${MAX_LESSON_SOURCE_MB} MB.`, 413);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail("The upload was incomplete. Please try again.");
  }

  const parsed = lessonVideoSchema.safeParse(Object.fromEntries(
    ["subject", "grade", "topic", "language", "voice", "board"].map((k) => [k, form.get(k) ?? ""])
  ));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Check the form.");

  const file = form.get("file");
  let source: LessonSource | undefined;
  let topic = parsed.data.topic;
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_LESSON_SOURCE_MB * 1024 * 1024) {
      return fail(`Files can be at most ${MAX_LESSON_SOURCE_MB} MB.`, 413);
    }
    const mediaType = LESSON_SOURCE_TYPES[path.extname(file.name).toLowerCase()];
    if (!mediaType) return fail("Attach a PDF, PNG, JPG or WebP file.");
    source = { mediaType, data: Buffer.from(await file.arrayBuffer()).toString("base64") };
    const name = path.basename(file.name).replace(/[^\p{L}\p{N} ._()-]/gu, "").slice(0, 100);
    topic ||= `Explain the attached file: ${name}`;
  }
  if (topic.length < 3) return fail("Type what the video should explain, or attach a file.");

  try {
    const jobId = await startJob({ ...parsed.data, topic, source });
    recordAttempt(key, CREATE_WINDOW_MINUTES);
    return Response.json({ jobId }, { status: 202 });
  } catch (err) {
    if (!(err instanceof VideoServiceError)) console.log(err);
    return fail(
      err instanceof VideoServiceError ? err.message : "Something went wrong talking to the video service.",
      502
    );
  }
}
