"use server";

import { revalidatePath } from "next/cache";
import { auth } from "./auth";
import { lessonVideoSchema } from "./formValidationSchemas";
import type { VideoProgress } from "./lessonVideoOptions";
import prisma from "./prisma";
import { blockedFor, recordAttempt } from "./rateLimit";
import { getJob, JOB_ID, saveFinishedVideo, startJob, VideoServiceError } from "./videoService";

type State = { success: boolean; error: boolean; message?: string; jobId?: string };

const fail = (message: string): State => ({ success: false, error: true, message });

// Each video costs AI and rendering time, so creating them is limited
const CREATE_LIMIT = 5;
const CREATE_WINDOW_MINUTES = 60;

const isStaff = (role: string | undefined) => role === "admin" || role === "teacher";

const problemText = (err: unknown) =>
  err instanceof VideoServiceError ? err.message : "Something went wrong talking to the video service.";

export const startVideo = async (_state: State, formData: FormData): Promise<State> => {
  const { userId, role } = await auth();
  if (!userId || !isStaff(role)) return fail("Only admins and teachers can create videos.");

  const key = `video:create:${userId}`;
  const wait = blockedFor(key, CREATE_LIMIT);
  if (wait) return fail(`You've started ${CREATE_LIMIT} videos this hour. Try again in ${wait} minutes.`);

  const parsed = lessonVideoSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Check the form.");

  try {
    const jobId = await startJob(parsed.data);
    recordAttempt(key, CREATE_WINDOW_MINUTES);
    return { success: true, error: false, jobId };
  } catch (err) {
    if (!(err instanceof VideoServiceError)) console.log(err);
    return fail(problemText(err));
  }
};

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
    return { status: job.status, step: job.step, title: job.title, privacy: job.privacy, error: job.error };
  } catch (err) {
    if (!(err instanceof VideoServiceError)) console.log(err);
    // Keep polling: the service may just be restarting
    return { status: "unreachable", step: "", error: problemText(err) };
  }
};

// Removes the video from the app only; it stays on the YouTube channel
export const deleteVideo = async (_state: State, formData: FormData): Promise<State> => {
  const { userId, role } = await auth();
  if (!userId || !isStaff(role)) return fail("Only admins and teachers can delete videos.");
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id) || id < 1) return fail("Unknown video.");

  const { count } = await prisma.video.deleteMany({ where: { id } });
  if (count === 0) return fail("That video was already removed.");
  revalidatePath("/list/videos");
  return { success: true, error: false, message: "Removed from the app. It's still on YouTube." };
};
