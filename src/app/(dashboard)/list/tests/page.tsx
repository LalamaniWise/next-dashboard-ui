import Link from "next/link";
import ReadinessCard from "@/components/tests/ReadinessCard";
import {
  PublishTestButton,
  RefreshWhileWriting,
  WriteMissingTests,
  WriteTestButton,
} from "@/components/tests/TestForms";
import { auth } from "@/lib/auth";
import { gradeLabel } from "@/lib/phases";
import prisma from "@/lib/prisma";
import {
  currentTerm,
  learnerQuizWhere,
  learnerSelect,
  QuizLearner,
  quizLearnersFor,
  readinessBand,
  termReadiness,
  TESTED_MATERIAL_TYPES,
} from "@/lib/quizzes";
import { QuizStatus } from "@prisma/client";

// Room for Claude to write tests after the page's buttons answer
export const maxDuration = 300;

const statusText: Record<QuizStatus, { label: string; style: string }> = {
  GENERATING: { label: "Being written...", style: "bg-gray-100 text-gray-600" },
  FAILED: { label: "Couldn't be written", style: "bg-red-100 text-red-700" },
  PENDING: { label: "Waiting for review", style: "bg-lamaYellowLight text-gray-700" },
  PUBLISHED: { label: "Published", style: "bg-green-100 text-green-800" },
};

const marksOf = (questions: { marks: number }[]) => questions.reduce((sum, q) => sum + q.marks, 0);

// What a test is about, for the lists
const quizInclude = {
  video: { select: { id: true, title: true, subjectName: true, grade: true } },
  material: {
    select: { id: true, title: true, subject: { select: { name: true } }, grade: { select: { level: true } } },
  },
  questions: { select: { marks: true } },
} as const;

type QuizRow = {
  id: number;
  title: string;
  status: QuizStatus;
  error: string | null;
  video: { id: number; title: string; subjectName: string; grade: number } | null;
  material: { id: number; title: string; subject: { name: string }; grade: { level: number } | null } | null;
  questions: { marks: number }[];
};

const aboutText = (q: QuizRow) =>
  q.video
    ? `Video: ${q.video.title} · ${q.video.subjectName} · ${gradeLabel(q.video.grade)}`
    : q.material
    ? `Material: ${q.material.title} · ${q.material.subject.name} · ${q.material.grade ? gradeLabel(q.material.grade.level) : "All grades"}`
    : "";

const StaffTests = async ({ grade }: { grade?: string }) => {
  const [quizzes, missingVideos, missingMaterials, grades, term] = await Promise.all([
    prisma.quiz.findMany({
      include: { ...quizInclude, _count: { select: { attempts: true } } },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.video.findMany({
      where: { status: "PUBLISHED", quiz: null },
      select: { id: true, title: true, subjectName: true, grade: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.material.findMany({
      where: { type: { in: [...TESTED_MATERIAL_TYPES] }, quiz: null },
      select: { id: true, title: true, subject: { select: { name: true } }, grade: { select: { level: true } } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.grade.findMany({ orderBy: { level: "asc" }, select: { id: true, level: true } }),
    currentTerm(),
  ]);
  const toReview = quizzes.filter((q) => q.status !== "PUBLISHED");
  const published = quizzes.filter((q) => q.status === "PUBLISHED");
  const missing = missingVideos.length + missingMaterials.length;

  const chosenGrade = grades.find((g) => String(g.level) === grade);
  const learners = chosenGrade
    ? await prisma.student.findMany({
        where: { gradeId: chosenGrade.id },
        select: learnerSelect,
        orderBy: [{ name: "asc" }, { surname: "asc" }],
      })
    : [];
  const readiness = term
    ? await Promise.all(learners.map(async (s) => ({ s, r: await termReadiness(s, term) })))
    : [];

  const row = (q: (typeof quizzes)[number]) => (
    <tr key={q.id} className="border-t border-gray-100 even:bg-slate-50 align-top">
      <td className="py-2 pr-4">
        <p className="font-medium text-gray-900">{q.status === "GENERATING" ? "Test being written" : q.title}</p>
        <p className="text-xs text-gray-500">{aboutText(q)}</p>
        {q.status === "FAILED" && q.error && <p className="text-xs text-red-600">{q.error}</p>}
      </td>
      <td className="py-2 pr-4">
        <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${statusText[q.status].style}`}>
          {statusText[q.status].label}
        </span>
      </td>
      <td className="py-2 pr-4 hidden md:table-cell text-gray-600 whitespace-nowrap">
        {q.questions.length ? `${q.questions.length} questions · ${marksOf(q.questions)} marks` : "—"}
      </td>
      <td className="py-2 pr-4 hidden md:table-cell text-gray-600">{q._count.attempts}</td>
      <td className="py-2">
        <div className="flex flex-wrap items-center gap-2">
          {(q.status === "PENDING" || q.status === "PUBLISHED") && (
            <Link href={`/list/tests/${q.id}`} className="text-xs text-indigo-600 hover:underline">
              {q.status === "PENDING" ? "Check" : "View"}
            </Link>
          )}
          {(q.status === "PENDING" || q.status === "PUBLISHED") && (
            <PublishTestButton id={q.id} published={q.status === "PUBLISHED"} />
          )}
          {q._count.attempts === 0 && q.status !== "GENERATING" && (
            <WriteTestButton
              kind={q.video ? "video" : "material"}
              id={(q.video?.id ?? q.material?.id)!}
              rewrite={q.status !== "FAILED"}
            />
          )}
        </div>
      </td>
    </tr>
  );

  const table = (rows: typeof quizzes) => (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-gray-500">
            <th className="py-2 pr-4 font-medium">Test</th>
            <th className="py-2 pr-4 font-medium">Status</th>
            <th className="py-2 pr-4 font-medium hidden md:table-cell">Size</th>
            <th className="py-2 pr-4 font-medium hidden md:table-cell">Taken by</th>
            <th className="py-2 font-medium"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>{rows.map(row)}</tbody>
      </table>
    </div>
  );

  return (
    <>
      <RefreshWhileWriting active={quizzes.some((q) => q.status === "GENERATING")} />
      <section className="card p-4">
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-lg font-semibold">Tests to check</h1>
            <p className="text-xs text-gray-500 max-w-2xl">
              Claude writes a multiple-choice test (20 to 40 marks) for every published lesson video and every study
              material or question paper. Check the questions and answers, fix anything that&apos;s wrong, then publish
              it. Learners get one go at each test.
            </p>
          </div>
          <WriteMissingTests missing={missing} />
        </div>
        {toReview.length === 0 ? (
          <p className="mt-4 text-sm text-gray-500">Nothing is waiting for review.</p>
        ) : (
          table(toReview)
        )}
      </section>

      {missing > 0 && (
        <section className="card p-4">
          <h2 className="text-lg font-semibold">No test yet</h2>
          <p className="text-xs text-gray-500">Videos and materials added before tests existed, or whose test was removed.</p>
          <ul className="mt-3 flex flex-col divide-y divide-gray-100">
            {missingVideos.map((v) => (
              <li key={`v${v.id}`} className="flex items-center justify-between gap-4 py-2 text-sm">
                <span>
                  <span className="text-gray-900">{v.title}</span>{" "}
                  <span className="text-xs text-gray-500">· Video · {v.subjectName} · {gradeLabel(v.grade)}</span>
                </span>
                <WriteTestButton kind="video" id={v.id} />
              </li>
            ))}
            {missingMaterials.map((m) => (
              <li key={`m${m.id}`} className="flex items-center justify-between gap-4 py-2 text-sm">
                <span>
                  <span className="text-gray-900">{m.title}</span>{" "}
                  <span className="text-xs text-gray-500">
                    · Material · {m.subject.name} · {m.grade ? gradeLabel(m.grade.level) : "All grades"}
                  </span>
                </span>
                <WriteTestButton kind="material" id={m.id} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card p-4">
        <h2 className="text-lg font-semibold">Published tests</h2>
        {published.length === 0 ? (
          <p className="mt-2 text-sm text-gray-500">No tests are published yet.</p>
        ) : (
          table(published)
        )}
      </section>

      <section className="card p-4" id="readiness">
        <h2 className="text-lg font-semibold">Learner readiness</h2>
        <p className="text-xs text-gray-500">
          {term
            ? `${term.name}: each learner's marks out of every test published to them this term. Tests not taken count as 0.`
            : "Set this year's term dates in Settings to see readiness."}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {grades.map((g) => (
            <Link
              key={g.id}
              href={`/list/tests?grade=${g.level}#readiness`}
              aria-current={g.id === chosenGrade?.id ? "page" : undefined}
              className={`rounded-full px-3 py-1 text-xs ${g.id === chosenGrade?.id ? "bg-indigo-500 text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200"}`}
            >
              {gradeLabel(g.level)}
            </Link>
          ))}
        </div>
        {chosenGrade && term && (
          learners.length === 0 ? (
            <p className="mt-3 text-sm text-gray-500">No learners in {gradeLabel(chosenGrade.level)}.</p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500">
                    <th className="py-2 pr-4 font-medium">Learner</th>
                    <th className="py-2 pr-4 font-medium">Readiness</th>
                    <th className="py-2 pr-4 font-medium hidden md:table-cell">Tests taken</th>
                    <th className="py-2 font-medium hidden md:table-cell">Weakest subject</th>
                  </tr>
                </thead>
                <tbody>
                  {readiness.map(({ s, r }) => {
                    const weakest = [...r.subjects].sort((a, b) => a.percent - b.percent)[0];
                    return (
                      <tr key={s.id} className="border-t border-gray-100 even:bg-slate-50">
                        <td className="py-2 pr-4 text-gray-900">
                          {s.name} {s.surname}
                        </td>
                        <td className="py-2 pr-4">
                          {r.percent === null ? (
                            <span className="text-gray-500">No tests yet</span>
                          ) : (
                            <span className="flex items-center gap-2">
                              <span className="font-medium">{r.percent}%</span>
                              <span className={`rounded-full px-2 py-0.5 text-xs ${readinessBand(r.percent).style}`}>
                                {readinessBand(r.percent).label}
                              </span>
                            </span>
                          )}
                        </td>
                        <td className="py-2 pr-4 hidden md:table-cell text-gray-600">
                          {r.taken} of {r.tests}
                        </td>
                        <td className="py-2 hidden md:table-cell text-gray-600">
                          {weakest ? `${weakest.name} (${weakest.percent}%)` : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        )}
      </section>
    </>
  );
};

// The tests a learner can take, with their marks for the ones they've done
const LearnerTests = async ({ student, viewer }: { student: QuizLearner; viewer: "student" | "parent" }) => {
  const quizzes = await prisma.quiz.findMany({
    where: learnerQuizWhere(student),
    include: { ...quizInclude, attempts: { where: { studentId: student.id }, select: { score: true, total: true } } },
    orderBy: { publishedAt: "desc" },
  });

  return (
    <section className="card p-4">
      <h2 className="text-lg font-semibold">
        {viewer === "parent" ? `${student.name} ${student.surname}'s tests` : "Your tests"}
      </h2>
      <p className="text-xs text-gray-500">
        {viewer === "parent"
          ? "Multiple-choice tests on the lesson videos and study materials for your child's grade."
          : "One test for each lesson video and study material. You get one go at each, so watch or read first."}
      </p>
      {quizzes.length === 0 ? (
        <p className="mt-3 text-sm text-gray-500">No tests have been published yet.</p>
      ) : (
        <ul className="mt-3 flex flex-col divide-y divide-gray-100">
          {quizzes.map((q) => {
            const attempt = q.attempts[0];
            const percent = attempt ? Math.round((attempt.score / attempt.total) * 100) : null;
            return (
              <li key={q.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 py-3">
                <div>
                  <p className="text-sm font-medium text-gray-900">{q.title}</p>
                  <p className="text-xs text-gray-500">
                    {q.video ? q.video.subjectName : q.material?.subject.name} · {marksOf(q.questions)} marks ·{" "}
                    {q.video ? "Lesson video" : "Study material"}
                  </p>
                </div>
                {attempt ? (
                  <Link href={`/list/tests/${q.id}${viewer === "parent" ? `?student=${student.id}` : ""}`} className="flex items-center gap-2 text-sm">
                    <span className="font-medium text-gray-900">
                      {attempt.score}/{attempt.total} ({percent}%)
                    </span>
                    <span className="text-xs text-indigo-600 hover:underline">See answers</span>
                  </Link>
                ) : viewer === "student" ? (
                  <Link href={`/list/tests/${q.id}`} className="btn-primary text-center">
                    Take test
                  </Link>
                ) : (
                  <span className="text-xs text-gray-500">Not taken yet</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};

const TestsPage = async ({ searchParams }: { searchParams: Promise<{ [key: string]: string | undefined }> }) => {
  const { userId, role } = await auth();
  const { grade } = await searchParams;
  const learners = await quizLearnersFor(role, userId);

  return (
    <div className="flex-1 m-4 mt-0 flex flex-col gap-4">
      {learners === null ? (
        <StaffTests grade={grade} />
      ) : learners.length === 0 ? (
        <div className="card p-4 text-sm text-gray-500">
          {role === "parent"
            ? "Link your child on your dashboard to see their tests."
            : "Tests show here once your account is set up."}
        </div>
      ) : (
        <>
          <ReadinessCard students={learners} />
          {learners.map((s) => (
            <LearnerTests key={s.id} student={s} viewer={role === "parent" ? "parent" : "student"} />
          ))}
        </>
      )}
    </div>
  );
};

export default TestsPage;
