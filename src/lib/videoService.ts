import "server-only";
import type { LessonVideoSchema } from "./formValidationSchemas";
import {
  LESSON_VIDEO_GRADES,
  LESSON_VIDEO_SUBJECTS,
  LessonVideoFile,
  VideoJobStatus,
} from "./lessonVideoOptions";
import prisma from "./prisma";
import { parseYouTubeId, watchUrl } from "./youtube";

// The AI lesson-video service (ai/service). Only the server talks to it,
// with the shared secret; the browser never sees its address or secret.

export type VideoJob = {
  id: string;
  status: VideoJobStatus;
  step: string;
  subject: string;
  grade: number;
  topic: string;
  title: string | null;
  // The short topic and subtopic on the video's cover (from the form, or the AI's)
  lessonTopic?: string | null;
  subtopic?: string | null;
  youtubeUrl: string | null;
  privacy: string | null;
  files: LessonVideoFile[] | null;
  // Text to post with the video on TikTok or Facebook
  shareCaption?: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export class VideoServiceError extends Error {}

export const JOB_ID = /^[a-f0-9]{32}$/;

const serviceResponse = async (path: string, init?: RequestInit, timeoutMs = 10_000) => {
  const base = process.env.VIDEO_SERVICE_URL;
  const secret = process.env.VIDEO_SERVICE_SECRET;
  if (!base || !secret) {
    throw new VideoServiceError(
      "Lesson videos aren't set up yet: add VIDEO_SERVICE_URL and VIDEO_SERVICE_SECRET to .env (see ai/service/README.md)."
    );
  }

  let res: Response;
  try {
    res = await fetch(new URL(path, base), {
      ...init,
      headers: { "X-Video-Secret": secret, "Content-Type": "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new VideoServiceError(
      "The video service isn't running. Start it with: python ai/service/app.py"
    );
  }

  if (res.status === 401) {
    throw new VideoServiceError(
      "The app and the video service have different VIDEO_SERVICE_SECRET values."
    );
  }
  if (!res.ok) {
    const detail = (await res.json().catch(() => null))?.detail;
    throw new VideoServiceError(
      typeof detail === "string" ? detail : `The video service answered with error ${res.status}.`
    );
  }
  return res;
};

const serviceFetch = async <T>(path: string, init?: RequestInit, timeoutMs?: number): Promise<T> =>
  (await serviceResponse(path, init, timeoutMs)).json() as Promise<T>;

export type LessonSource = { mediaType: string; data: string };

// An attached file travels with the request, so allow it more time
export const startJob = async (request: LessonVideoSchema & { source?: LessonSource }) =>
  (await serviceFetch<{ jobId: string }>("/jobs", {
    method: "POST",
    body: JSON.stringify(request),
  }, 60_000)).jobId;

export const jobFile = (jobId: string, kind: LessonVideoFile) =>
  serviceResponse(`/jobs/${jobId}/files/${kind}`, undefined, 120_000);

export const getJob = (jobId: string) => serviceFetch<VideoJob>(`/jobs/${jobId}`);

export const recentJobs = async () =>
  (await serviceFetch<{ jobs: VideoJob[] }>("/jobs?limit=20")).jobs;

// A dry run (DRY_RUN=1) gives a made-up YouTube link, so it's never saved
const isSavable = (job: VideoJob) =>
  job.status === "done" && !!job.youtubeUrl && job.privacy !== "dry-run";

// Saves a finished job as a Video. Everything comes from the service's
// answer, never from the browser. Safe to call again for the same job.
export const saveFinishedVideo = async (job: VideoJob) => {
  if (!isSavable(job)) return null;
  const youtubeId = job.youtubeUrl ? parseYouTubeId(job.youtubeUrl) : null;
  if (
    !youtubeId ||
    !(LESSON_VIDEO_SUBJECTS as readonly string[]).includes(job.subject) ||
    !(LESSON_VIDEO_GRADES as readonly number[]).includes(job.grade)
  ) {
    throw new VideoServiceError("The video service sent back a video the app can't use.");
  }
  const youtubeUrl = watchUrl(youtubeId);
  const title = (job.title || job.topic).trim().slice(0, 150);
  return prisma.video.upsert({
    where: { youtubeUrl },
    create: {
      title,
      youtubeUrl,
      subjectName: job.subject,
      grade: job.grade,
      topic: job.lessonTopic?.trim().slice(0, 80) || null,
      subtopic: job.subtopic?.trim().slice(0, 120) || null,
    },
    update: {},
  });
};

// Saves every finished job not saved yet, e.g. when nobody kept the page
// open until the video was done
export const saveFinishedVideos = async (jobs: VideoJob[]) => {
  const done = jobs.filter(isSavable);
  if (done.length === 0) return;
  const urls = done
    .map((j) => parseYouTubeId(j.youtubeUrl!))
    .filter((id): id is string => !!id)
    .map(watchUrl);
  const saved = new Set(
    (await prisma.video.findMany({ where: { youtubeUrl: { in: urls } }, select: { youtubeUrl: true } }))
      .map((v) => v.youtubeUrl)
  );
  for (const job of done) {
    const id = parseYouTubeId(job.youtubeUrl!);
    if (id && !saved.has(watchUrl(id))) {
      await saveFinishedVideo(job).catch((err) => console.log(err));
    }
  }
};

// Grades whose lesson videos a learner sees: their own, or a parent's
// children's. null means every grade (admins and teachers).
export const videoGradesFor = async (
  role: string | undefined,
  userId: string | null
): Promise<number[] | null> => {
  if (role === "admin" || role === "teacher") return null;
  if (!userId) return [];
  const students =
    role === "student"
      ? await prisma.student.findMany({ where: { id: userId }, select: { grade: { select: { level: true } } } })
      : role === "parent"
      ? await prisma.student.findMany({ where: { parentId: userId }, select: { grade: { select: { level: true } } } })
      : [];
  return [...new Set(students.map((s) => s.grade.level))];
};
