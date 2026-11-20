"use server";

import { revalidatePath } from "next/cache";
import { auth } from "./auth";
import { publishVideoSchema, videoSchema } from "./formValidationSchemas";
import type { VideoProgress } from "./lessonVideoOptions";
import prisma from "./prisma";
import { getJob, JOB_ID, saveFinishedVideo, VideoServiceError } from "./videoService";
import { parseYouTubeId, watchUrl } from "./youtube";

type State = { success: boolean; error: boolean; message?: string };

const fail = (message: string): State => ({ success: false, error: true, message });

const isStaff = (role: string | undefined) => role === "admin" || role === "teacher";

const problemText = (err: unknown) =>
  err instanceof VideoServiceError ? err.message : "Something went wrong talking to the video service.";

// Polled by the browser while a video is being made. When it's done, the
// Video row is saved here, from what the service says.
export const videoProgress = async (jobId: string): Promise<VideoProgress> => {
  const { userId, role } = await auth();
  if (!userId || !isStaff(role)) {
    return { status: "failed", step: "Failed", error: "Only admins and teachers can see this." };
  }
  if (typeof jobId !== "string" || !JOB_ID.test(jobId)) {
    return { status: "failed", step: "Failed", error: "Unknown video." };
  }

  try {
    const job = await getJob(jobId);
    if (job.status === "done") {
      await saveFinishedVideo(job);
      revalidatePath("/list/videos");
    }
    return {
      status: job.status,
      step: job.step,
      title: job.title,
      privacy: job.privacy,
      files: job.files,
      error: job.error,
    };
  } catch (err) {
    if (!(err instanceof VideoServiceError)) console.log(err);
    // Keep polling: the service may just be restarting
    return { status: "unreachable", step: "", error: problemText(err) };
  }
};

const firstIssue = (err: { issues: { message: string }[] }) => err.issues[0]?.message ?? "Check the form.";

const refresh = () => {
  revalidatePath("/list/videos");
  revalidatePath("/admin");
  revalidatePath("/teacher");
};

// Adds a video from a YouTube link, or edits one. New videos wait for an
// admin to publish them. A teacher's edit sends a published video back for
// approval, so learners only ever see what an admin has checked.
export const saveVideo = async (_state: State, formData: FormData): Promise<State> => {
  const { userId, role } = await auth();
  if (!userId || !isStaff(role)) return fail("Only admins and teachers can change videos.");
  const parsed = videoSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fail(firstIssue(parsed.error));
  const { id, youtubeUrl, title, subject, grade, topic, subtopic } = parsed.data;
  const fields = { title, subjectName: subject, grade, topic: topic || null, subtopic: subtopic || null };

  if (id) {
    const video = await prisma.video.findUnique({ where: { id }, select: { status: true } });
    if (!video) return fail("That video was removed.");
    const backToPending = role === "teacher" && video.status === "PUBLISHED";
    await prisma.video.update({
      where: { id },
      data: backToPending ? { ...fields, status: "PENDING", grades: { set: [] } } : fields,
    });
    refresh();
    return {
      success: true,
      error: false,
      message: backToPending ? "Saved. It's waiting for an admin to publish it again." : "Saved.",
    };
  }

  const youtubeId = parseYouTubeId(youtubeUrl ?? "");
  if (!youtubeId) return fail("Paste a YouTube video link.");
  const url = watchUrl(youtubeId);
  if (await prisma.video.findUnique({ where: { youtubeUrl: url }, select: { id: true } })) {
    return fail("That video is already in the list.");
  }
  await prisma.video.create({ data: { ...fields, youtubeUrl: url } });
  refresh();
  return { success: true, error: false, message: "Added. It's waiting for an admin to publish it." };
};

// Admins choose which grades see a video. Also changes the grades of one
// that's already published.
export const publishVideo = async (_state: State, formData: FormData): Promise<State> => {
  const { userId, role } = await auth();
  if (!userId || role !== "admin") return fail("Only admins can publish videos.");
  const parsed = publishVideoSchema.safeParse({ id: formData.get("id"), grades: formData.getAll("grades") });
  if (!parsed.success) return fail(firstIssue(parsed.error));
  const { id, grades } = parsed.data;

  const found = await prisma.grade.count({ where: { id: { in: grades } } });
  if (found !== new Set(grades).size) return fail("One of those grades no longer exists.");
  if (!(await prisma.video.findUnique({ where: { id }, select: { id: true } }))) {
    return fail("That video was removed.");
  }
  await prisma.video.update({
    where: { id },
    data: { status: "PUBLISHED", grades: { set: grades.map((g) => ({ id: g })) } },
  });
  refresh();
  return { success: true, error: false, message: "Published. Learners in those grades can watch it now." };
};

// Removes the video from the app only; it stays on the YouTube channel.
// Admins declining a video waiting for approval use this too.
export const deleteVideo = async (_state: State, formData: FormData): Promise<State> => {
  const { userId, role } = await auth();
  if (!userId || !isStaff(role)) return fail("Only admins and teachers can delete videos.");
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id) || id < 1) return fail("Unknown video.");
  const declining = formData.get("decline") === "1";
  if (declining && role !== "admin") return fail("Only admins can decline videos.");

  const { count } = await prisma.video.deleteMany({ where: { id } });
  if (count === 0) return fail("That video was already removed.");
  refresh();
  return {
    success: true,
    error: false,
    message: `${declining ? "Declined and removed" : "Removed"} from the app. It's still on YouTube.`,
  };
};
