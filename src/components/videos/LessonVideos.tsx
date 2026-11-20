import Image from "next/image";
import Link from "next/link";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { recentJobs, saveFinishedVideos, VideoJob, videoGradesFor, VideoServiceError } from "@/lib/videoService";
import { embedUrl, parseYouTubeId } from "@/lib/youtube";
import {
  JobDownloads,
  JobProgress,
  LessonVideoCreate,
  VideoAdd,
  VideoDelete,
  VideoEdit,
  VideoPublish,
} from "./LessonVideoForms";

const PER_PAGE = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

type Query = { [key: string]: string | undefined };

const dateText = (d: Date) =>
  d.toLocaleDateString("en-ZA", { day: "numeric", month: "short", year: "numeric" });

// Links that change one setting of this section and keep the rest of the page's filters
const hrefWith = (query: Query, changes: Query) => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...query, ...changes })) if (v) params.set(k, v);
  const text = params.toString();
  return `/list/videos${text ? `?${text}` : ""}#lesson-videos`;
};

// Videos being made, ones that failed in the last day, and finished ones with
// files to download. Finished ones nobody waited for are saved here.
const serviceJobs = async (): Promise<{ jobs: VideoJob[]; ready: VideoJob[]; problem?: string }> => {
  try {
    const jobs = await recentJobs();
    await saveFinishedVideos(jobs);
    return {
      jobs: jobs.filter(
        (j) =>
          !["done", "failed"].includes(j.status) ||
          (j.status === "failed" && Date.now() - Date.parse(j.updatedAt) < DAY_MS)
      ),
      ready: jobs.filter((j) => j.status === "done" && j.files?.length),
    };
  } catch (err) {
    if (!(err instanceof VideoServiceError)) console.log(err);
    return {
      jobs: [],
      ready: [],
      problem: err instanceof VideoServiceError ? err.message : "The video service couldn't be checked.",
    };
  }
};

const LessonVideos = async ({
  role,
  userId,
  query,
}: {
  role: string | undefined;
  userId: string | null;
  query: Query;
}) => {
  const canCreate = role === "admin" || role === "teacher";
  const isAdmin = role === "admin";
  const grades = await videoGradesFor(role, userId);
  // Learners see published videos for their grades; staff see every video,
  // those waiting for approval first
  const where: Prisma.VideoWhereInput = grades
    ? { status: "PUBLISHED", grades: { some: { level: { in: grades } } } }
    : {};
  const page = Math.max(1, parseInt(query.lvpage ?? "1") || 1);

  // Finished jobs are saved before the list is read, so new videos show straight away
  const service = canCreate
    ? await serviceJobs()
    : { jobs: [] as VideoJob[], ready: [] as VideoJob[], problem: undefined };
  const [videos, count, schoolGrades] = await Promise.all([
    prisma.video.findMany({
      where,
      include: { grades: { select: { id: true, level: true }, orderBy: { level: "asc" } } },
      orderBy: [...(canCreate ? [{ status: "asc" as const }] : []), { createdAt: "desc" }],
      take: PER_PAGE,
      skip: PER_PAGE * (page - 1),
    }),
    prisma.video.count({ where }),
    isAdmin ? prisma.grade.findMany({ select: { id: true, level: true }, orderBy: { level: "asc" } }) : [],
  ]);

  // Learners and parents with nothing to watch don't need this section
  if (!canCreate && count === 0) return null;

  const pages = Math.ceil(count / PER_PAGE);
  const pager = pages > 1 && (
    <div className="mt-4 flex items-center justify-between text-sm">
      {page > 1 ? (
        <Link href={hrefWith(query, { lvpage: String(page - 1), lv: undefined })} className="text-indigo-600 hover:underline">
          ← Newer
        </Link>
      ) : <span />}
      <span className="text-gray-500">Page {page} of {pages}</span>
      {page < pages ? (
        <Link href={hrefWith(query, { lvpage: String(page + 1), lv: undefined })} className="text-indigo-600 hover:underline">
          Older →
        </Link>
      ) : <span />}
    </div>
  );

  const playing = videos.find((v) => String(v.id) === query.lv) ?? videos[0];
  const playingId = playing ? parseYouTubeId(playing.youtubeUrl) : null;

  return (
    <section id="lesson-videos" className="card p-4">
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-lg font-semibold">Lesson videos</h1>
          <p className="text-xs text-gray-500">
            {canCreate
              ? "Short AI lessons from your request or file, with an activity and memo to download."
              : role === "parent"
              ? "Short video lessons for your children's grades."
              : "Short video lessons for your grade."}
          </p>
        </div>
        {canCreate && (
          <div className="flex items-center gap-2">
            <VideoAdd />
            <LessonVideoCreate />
          </div>
        )}
      </div>
      {canCreate && (
        <p className="mt-2 text-xs text-gray-500">
          {isAdmin
            ? "New videos wait for you to approve them. Approve one to publish it to the grades you choose, or decline it to remove it."
            : "New videos wait for an admin to approve them before students and parents can see them."}
        </p>
      )}

      {canCreate && (service.problem || service.jobs.length > 0) && (
        <div className="mt-4 flex flex-col gap-3 rounded-lg border border-gray-200 p-3">
          {service.problem && <p className="text-sm text-gray-600">{service.problem}</p>}
          {service.jobs.map((job) => (
            <div key={job.id} className="flex flex-col gap-1">
              <p className="text-xs text-gray-500">
                {job.subject} · Grade {job.grade} · {job.topic}
              </p>
              <JobProgress jobId={job.id} initialStep={job.step} />
            </div>
          ))}
        </div>
      )}

      {service.ready.length > 0 && (
        <div className="mt-4 flex flex-col gap-3 rounded-lg border border-gray-200 p-3">
          <h2 className="text-sm font-semibold text-gray-900">Ready to download</h2>
          {service.ready.map((job) => (
            <div key={job.id} className="flex flex-col gap-1">
              <p className="text-xs text-gray-500">
                {job.title ?? job.topic} · {job.subject} · Grade {job.grade}
              </p>
              <JobDownloads jobId={job.id} files={job.files ?? []} />
            </div>
          ))}
        </div>
      )}

      {canCreate ? (
        count === 0 ? (
          <p className="mt-4 text-sm text-gray-500">No lesson videos yet. Use Create video to make one.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500">
                  <th className="py-2 pr-4 font-medium">Title</th>
                  <th className="py-2 pr-4 font-medium hidden md:table-cell">Subject</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 pr-4 font-medium">YouTube</th>
                  <th className="py-2 pr-4 font-medium hidden md:table-cell">Added</th>
                  <th className="py-2 font-medium"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {videos.map((v) => {
                  const published = v.status === "PUBLISHED";
                  return (
                    <tr key={v.id} className="border-t border-gray-100 even:bg-slate-50">
                      <td className="py-2 pr-4 font-medium text-gray-900">{v.title}</td>
                      <td className="py-2 pr-4 hidden md:table-cell text-gray-600">
                        {v.subjectName} · Made for Grade {v.grade}
                      </td>
                      <td className="py-2 pr-4">
                        {published ? (
                          <span className="text-xs text-green-700">
                            Published · {v.grades.map((g) => `Grade ${g.level}`).join(", ")}
                          </span>
                        ) : (
                          <span className="rounded-full bg-lamaYellowLight px-2 py-0.5 text-xs font-medium text-gray-700">
                            Waiting for approval
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-4">
                        <a href={v.youtubeUrl} target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:underline">
                          Open
                        </a>
                      </td>
                      <td className="py-2 pr-4 hidden md:table-cell text-gray-600">{dateText(v.createdAt)}</td>
                      <td className="py-2">
                        <div className="flex items-center gap-2">
                          {isAdmin && (
                            <VideoPublish
                              id={v.id}
                              title={v.title}
                              published={published}
                              grades={schoolGrades}
                              selected={
                                published
                                  ? v.grades.map((g) => g.id)
                                  : schoolGrades.filter((g) => g.level === v.grade).map((g) => g.id)
                              }
                            />
                          )}
                          {isAdmin && !published && <VideoDelete id={v.id} title={v.title} decline />}
                          <VideoEdit
                            video={{ id: v.id, title: v.title, subjectName: v.subjectName, grade: v.grade, topic: v.topic, subtopic: v.subtopic }}
                          />
                          {(published || !isAdmin) && <VideoDelete id={v.id} title={v.title} />}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      ) : (
        <div className="mt-4 grid grid-cols-1 lg:grid-cols-3 gap-4">
          {playing && playingId && (
            <div className="lg:col-span-2 flex flex-col gap-2">
              <div className="relative aspect-video overflow-hidden rounded-xl bg-gray-900">
                <iframe
                  key={playing.id}
                  src={embedUrl(playingId)}
                  title={playing.title}
                  className="absolute inset-0 h-full w-full"
                  allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen"
                  allowFullScreen
                  referrerPolicy="strict-origin-when-cross-origin"
                />
              </div>
              <h2 className="font-semibold text-gray-900">{playing.title}</h2>
              <p className="text-xs text-gray-500">
                {playing.subjectName} · Grade {playing.grade} · {dateText(playing.createdAt)}
              </p>
              <p className="text-xs text-gray-500">
                If the player says the video is private, the school is still waiting for YouTube to approve its uploads.
              </p>
            </div>
          )}
          <ul className="flex flex-col gap-2">
            {videos.map((v) => {
              const id = parseYouTubeId(v.youtubeUrl);
              const active = v.id === playing?.id;
              return (
                <li key={v.id}>
                  <Link
                    href={hrefWith(query, { lv: String(v.id) })}
                    aria-current={active ? "true" : undefined}
                    className={`flex gap-3 rounded-lg p-2 transition ${active ? "bg-lamaSkyLight" : "hover:bg-gray-50"}`}
                  >
                    <div className="relative h-14 w-24 shrink-0 overflow-hidden rounded-md bg-gray-100">
                      {id && <Image src={`/api/covers/video/${v.id}`} alt="" fill unoptimized className="object-cover" />}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 line-clamp-2">{v.title}</p>
                      <p className="text-xs text-gray-500">{v.subjectName} · Grade {v.grade}</p>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {pager}
    </section>
  );
};

export default LessonVideos;
