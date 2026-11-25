import Image from "next/image";
import Link from "next/link";
import { Prisma } from "@prisma/client";
import { materialAccessWhere } from "@/lib/materials";
import { formatFileSize, materialTypeLabels, materialTypeStyles } from "@/lib/materialTypes";
import { gradeLabel } from "@/lib/phases";
import prisma from "@/lib/prisma";
import { embedUrl, parseYouTubeId } from "@/lib/youtube";

type Query = { [key: string]: string | undefined };

const hrefWith = (basePath: string, query: Query, changes: Query) => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...query, ...changes })) if (v) params.set(k, v);
  const text = params.toString();
  return `${basePath}${text ? `?${text}` : ""}#resources`;
};

// The published lesson videos and study materials for one grade (and, on a
// lesson's page, one subject), each with a link to its test. Learners only
// get here for their own grade, and see the materials for their subjects.
const GradeResources = async ({
  grade,
  subject,
  role,
  userId,
  basePath,
  query,
}: {
  grade: { id: number; level: number };
  subject?: { id: number; name: string };
  role: string | undefined;
  userId: string | null;
  basePath: string;
  query: Query;
}) => {
  const access = await materialAccessWhere(role, userId);
  const isStudent = role === "student";

  const videoWhere: Prisma.VideoWhereInput = {
    status: "PUBLISHED",
    grades: { some: { id: grade.id } },
    ...(subject && { subjectName: subject.name }),
  };
  const materialWhere: Prisma.MaterialWhereInput = {
    AND: [
      access ?? { id: -1 },
      { OR: [{ gradeId: grade.id }, { gradeId: null }] },
      ...(subject ? [{ subjectId: subject.id }] : []),
    ],
  };
  // The learner's own mark on each published test
  const quizSelect = {
    select: {
      id: true,
      status: true,
      attempts: isStudent && userId ? { where: { studentId: userId }, select: { score: true, total: true } } : false,
    },
  } as const;

  const [videos, materials] = await Promise.all([
    prisma.video.findMany({ where: videoWhere, include: { quiz: quizSelect }, orderBy: [{ subjectName: "asc" }, { createdAt: "asc" }] }),
    prisma.material.findMany({
      where: materialWhere,
      include: { subject: { select: { name: true } }, quiz: quizSelect },
      orderBy: [{ subject: { name: "asc" } }, { createdAt: "desc" }],
    }),
  ]);

  const playing = videos.find((v) => String(v.id) === query.v) ?? videos[0];
  const playingId = playing ? parseYouTubeId(playing.youtubeUrl) : null;

  type QuizInfo = { id: number; status: string; attempts?: { score: number; total: number }[] } | null;
  const testLink = (quiz: QuizInfo) => {
    if (!quiz || quiz.status !== "PUBLISHED") {
      return role === "admin" || role === "teacher" ? (
        <Link href="/list/tests" className="text-xs text-gray-500 hover:underline">
          {quiz ? "Test not published" : "No test yet"}
        </Link>
      ) : null;
    }
    const attempt = quiz.attempts?.[0];
    return (
      <Link href={`/list/tests/${quiz.id}`} className="text-xs font-medium text-indigo-600 hover:underline">
        {attempt ? `Test: ${attempt.score}/${attempt.total}` : isStudent ? "Take the test" : "Test"}
      </Link>
    );
  };

  const subjects = [...new Set([...videos.map((v) => v.subjectName), ...materials.map((m) => m.subject.name)])].sort();
  const label = `${gradeLabel(grade.level)}${subject ? ` ${subject.name}` : ""}`;

  return (
    <div id="resources" className="flex flex-col gap-4">
      <section className="card p-4">
        <h2 className="text-lg font-semibold">Lesson videos</h2>
        {videos.length === 0 ? (
          <p className="mt-2 text-sm text-gray-500">No lesson videos for {label} yet.</p>
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
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="font-semibold text-gray-900">{playing.title}</h3>
                    <p className="text-xs text-gray-500">
                      {playing.subjectName}
                      {playing.topic ? ` · ${playing.topic}` : ""}
                    </p>
                  </div>
                  {testLink(playing.quiz)}
                </div>
              </div>
            )}
            <ul className="flex flex-col gap-2 lg:max-h-[28rem] lg:overflow-y-auto">
              {videos.map((v) => {
                const active = v.id === playing?.id;
                return (
                  <li key={v.id}>
                    <Link
                      href={hrefWith(basePath, query, { v: String(v.id) })}
                      aria-current={active ? "true" : undefined}
                      className={`flex gap-3 rounded-lg p-2 transition ${active ? "bg-lamaSkyLight" : "hover:bg-gray-50"}`}
                    >
                      <div className="relative h-14 w-24 shrink-0 overflow-hidden rounded-md bg-gray-100">
                        <Image src={`/api/covers/video/${v.id}`} alt="" fill unoptimized className="object-cover" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900 line-clamp-2">{v.title}</p>
                        <p className="text-xs text-gray-500">{v.subjectName}</p>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </section>

      <section className="card p-4">
        <h2 className="text-lg font-semibold">Study material</h2>
        {materials.length === 0 ? (
          <p className="mt-2 text-sm text-gray-500">No study material for {label} yet.</p>
        ) : (
          (subject ? [subject.name] : subjects)
            .filter((name) => materials.some((m) => m.subject.name === name))
            .map((name) => (
              <div key={name} className="mt-4">
                {!subject && <h3 className="text-sm font-semibold text-gray-700">{name}</h3>}
                <ul className="mt-2 flex flex-col divide-y divide-gray-100">
                  {materials
                    .filter((m) => m.subject.name === name)
                    .map((m) => (
                      <li key={m.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 py-2">
                        <div className="min-w-0">
                          <a href={`/api/materials/${m.id}`} className="text-sm font-medium text-gray-900 hover:text-indigo-600">
                            {m.title}
                          </a>
                          <p className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
                            <span className={`rounded-full px-2 py-0.5 ${materialTypeStyles[m.type]}`}>
                              {materialTypeLabels[m.type]}
                            </span>
                            {m.gradeId === null && <span>All grades</span>}
                            {m.year && <span>{m.year}</span>}
                            <span>{formatFileSize(m.size)}</span>
                          </p>
                        </div>
                        <div className="flex items-center gap-3">
                          {testLink(m.quiz)}
                          <a href={`/api/materials/${m.id}`} className="text-xs text-indigo-600 hover:underline">
                            Download
                          </a>
                        </div>
                      </li>
                    ))}
                </ul>
              </div>
            ))
        )}
      </section>
    </div>
  );
};

export default GradeResources;
