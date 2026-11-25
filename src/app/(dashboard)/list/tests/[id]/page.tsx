import Link from "next/link";
import { notFound } from "next/navigation";
import { PublishTestButton, QuestionEditor, TakeTestForm } from "@/components/tests/TestForms";
import { auth } from "@/lib/auth";
import { gradeLabel } from "@/lib/phases";
import prisma from "@/lib/prisma";
import { learnerQuizWhere, parseOptions, quizLearnersFor } from "@/lib/quizzes";

const LETTERS = ["A", "B", "C", "D"];

const TestPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | undefined }>;
}) => {
  const { userId, role } = await auth();
  const id = Number((await params).id);
  if (!Number.isInteger(id)) notFound();
  const learners = await quizLearnersFor(role, userId);

  // A parent picks which child's marks to see; a student sees their own
  const { student: chosen } = await searchParams;
  const learner = learners === null ? null : learners.find((s) => s.id === chosen) ?? learners[0];
  if (learners !== null && !learner) notFound();

  const quiz = await prisma.quiz.findFirst({
    where: learner ? { AND: [{ id }, learnerQuizWhere(learner)] } : { id },
    include: {
      video: { select: { title: true, subjectName: true, grade: true, youtubeUrl: true } },
      material: { select: { id: true, title: true, subject: { select: { name: true } }, grade: { select: { level: true } } } },
      questions: { orderBy: { position: "asc" } },
      _count: { select: { attempts: true } },
    },
  });
  if (!quiz || quiz.status === "GENERATING" || quiz.status === "FAILED") notFound();

  const questions = quiz.questions.map((q) => ({ ...q, options: parseOptions(q.options) }));
  const total = questions.reduce((sum, q) => sum + q.marks, 0);
  const about = quiz.video
    ? `${quiz.video.subjectName} · ${gradeLabel(quiz.video.grade)} · Lesson video: ${quiz.video.title}`
    : quiz.material
    ? `${quiz.material.subject.name} · ${quiz.material.grade ? gradeLabel(quiz.material.grade.level) : "All grades"} · Material: ${quiz.material.title}`
    : "";
  const sourceLink = quiz.video ? (
    <a href={quiz.video.youtubeUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-indigo-600 hover:underline">
      Watch the video
    </a>
  ) : quiz.material ? (
    <a href={`/api/materials/${quiz.material.id}`} className="text-xs text-indigo-600 hover:underline">
      Open the material
    </a>
  ) : null;

  const header = (
    <div className="flex flex-col gap-1">
      <Link href="/list/tests" className="text-xs text-gray-500 hover:text-gray-700">
        ← All tests
      </Link>
      <h1 className="text-lg font-semibold">{quiz.title}</h1>
      <p className="text-xs text-gray-500">
        {about} · {questions.length} questions · {total} marks
      </p>
      {sourceLink}
    </div>
  );

  // Staff check the questions and publish
  if (learner === null) {
    const locked = quiz._count.attempts > 0;
    return (
      <div className="flex-1 m-4 mt-0 card p-4 flex flex-col gap-4">
        <div className="flex items-start justify-between flex-wrap gap-4">
          {header}
          <PublishTestButton id={quiz.id} published={quiz.status === "PUBLISHED"} />
        </div>
        <p className="text-sm text-gray-600 bg-gray-50 rounded-lg px-3 py-2">
          {locked
            ? `${quiz._count.attempts} learner${quiz._count.attempts === 1 ? " has" : "s have"} taken this test, so its questions can no longer change.`
            : "Check every question and its correct answer (shown in green). Edit or remove anything that's wrong, then publish. A test must be out of 20 to 40 marks."}
        </p>
        <ol className="flex flex-col gap-3">
          {questions.map((q, n) => (
            <QuestionEditor key={q.id} number={n + 1} question={q} locked={locked} />
          ))}
        </ol>
      </div>
    );
  }

  const attempt = await prisma.quizAttempt.findUnique({
    where: { quizId_studentId: { quizId: quiz.id, studentId: learner.id } },
  });

  if (!attempt) {
    return (
      <div className="flex-1 m-4 mt-0 card p-4 flex flex-col gap-4">
        {header}
        {role === "student" ? (
          <TakeTestForm
            quizId={quiz.id}
            questions={questions.map(({ id, question, options, marks }) => ({ id, question, options, marks }))}
          />
        ) : (
          <p className="text-sm text-gray-500">
            {learner.name} hasn&apos;t taken this test yet.
          </p>
        )}
      </div>
    );
  }

  // After handing in: the marks, and the right answer for every question
  let chosenAnswers: Record<string, number> = {};
  try {
    chosenAnswers = JSON.parse(attempt.answers);
  } catch {}
  const percent = Math.round((attempt.score / attempt.total) * 100);

  return (
    <div className="flex-1 m-4 mt-0 card p-4 flex flex-col gap-4">
      {header}
      <div className="rounded-lg bg-lamaSkyLight px-4 py-3">
        <p className="text-2xl font-semibold text-gray-900">
          {attempt.score}/{attempt.total} <span className="text-base font-normal text-gray-600">({percent}%)</span>
        </p>
        <p className="text-xs text-gray-600">
          {role === "parent" ? `${learner.name} handed in` : "Handed in"}{" "}
          {attempt.createdAt.toLocaleDateString("en-ZA", { day: "numeric", month: "long", year: "numeric" })}
        </p>
      </div>
      <ol className="flex flex-col gap-3">
        {questions.map((q, n) => {
          const picked = chosenAnswers[q.id];
          const right = picked === q.answer;
          return (
            <li key={q.id} className="rounded-lg border border-gray-200 p-4 flex flex-col gap-2">
              <div className="flex items-start justify-between gap-4">
                <p className="text-sm font-medium text-gray-900 whitespace-pre-line">
                  {n + 1}. {q.question}
                </p>
                <span className={`shrink-0 text-xs font-medium ${right ? "text-green-700" : "text-red-600"}`}>
                  {right ? q.marks : 0}/{q.marks}
                </span>
              </div>
              <ol className="flex flex-col gap-1 text-sm">
                {q.options.map((option, i) => (
                  <li
                    key={i}
                    className={`rounded-md px-2 py-1 ${
                      i === q.answer
                        ? "bg-green-50 text-green-800 font-medium"
                        : i === picked
                        ? "bg-red-50 text-red-700 line-through"
                        : "text-gray-700"
                    }`}
                  >
                    {LETTERS[i]}. {option}
                    {i === q.answer && <span className="ml-2 text-xs no-underline">✓ correct answer</span>}
                    {i === picked && i !== q.answer && <span className="sr-only"> (chosen, wrong)</span>}
                  </li>
                ))}
              </ol>
              {q.explanation && <p className="text-xs text-gray-600">{q.explanation}</p>}
            </li>
          );
        })}
      </ol>
    </div>
  );
};

export default TestPage;
