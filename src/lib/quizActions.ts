"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { z } from "zod";
import { auth } from "./auth";
import prisma from "./prisma";
import { missingQuizSources, QuizSource, startQuiz, writeQuiz } from "./quizGenerator";
import { learnerQuizWhere, learnerSelect, parseOptions } from "./quizzes";

type State = { success: boolean; error: boolean; message?: string };

const fail = (message: string): State => ({ success: false, error: true, message });
const done = (message?: string): State => ({ success: true, error: false, message });

const isStaff = (role: string | undefined) => role === "admin" || role === "teacher";

// A whole test is out of 20 to 40 marks
const MIN_MARKS = 20;
const MAX_MARKS = 40;

// Tests in "Learning by grade" and on lesson pages, the dashboards (readiness)
// and the Tests list all change together
const refresh = () => {
  revalidatePath("/list/tests", "layout");
  revalidatePath("/list/learning");
  revalidatePath("/student");
  revalidatePath("/parent");
};

const sourceSchema = z.object({
  kind: z.enum(["video", "material"]),
  id: z.coerce.number().int().min(1),
});

const toSource = ({ kind, id }: z.infer<typeof sourceSchema>): QuizSource =>
  kind === "video" ? { videoId: id } : { materialId: id };

// Has Claude write (or rewrite) the test for one video or material. It runs
// after the page answers; the page shows it as being written meanwhile.
export const writeTest = async (_state: State, formData: FormData): Promise<State> => {
  const { userId, role } = await auth();
  if (!userId || !isStaff(role)) return fail("Only admins and teachers can write tests.");
  const parsed = sourceSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fail("Unknown video or material.");
  const source = toSource(parsed.data);

  const started = await startQuiz(source);
  if ("error" in started) return fail(started.error);
  after(async () => {
    await writeQuiz(started.id, source);
    refresh();
  });
  refresh();
  return done("Claude is writing the test. It takes a minute or two.");
};

// Up to this many at a time, so one click doesn't run past the server's time limit
const MISSING_BATCH = 4;

// Writes tests for published videos and materials that don't have one yet,
// such as those added before tests existed
export const writeMissingTests = async (_state: State, _formData: FormData): Promise<State> => {
  const { userId, role } = await auth();
  if (!userId || !isStaff(role)) return fail("Only admins and teachers can write tests.");

  const sources = await missingQuizSources(MISSING_BATCH);
  if (sources.length === 0) return done("Every video and material already has a test.");
  const started: { id: number; source: QuizSource }[] = [];
  for (const source of sources) {
    const result = await startQuiz(source);
    if ("id" in result) started.push({ id: result.id, source });
  }
  after(async () => {
    for (const { id, source } of started) {
      await writeQuiz(id, source);
      refresh();
    }
  });
  refresh();
  return done(
    `Claude is writing ${started.length} test${started.length === 1 ? "" : "s"}. Click again afterwards for the rest.`
  );
};

// Teachers and admins publish a test once they've checked it. It counts
// towards the term in which it was first published.
export const publishTest = async (_state: State, formData: FormData): Promise<State> => {
  const { userId, role } = await auth();
  if (!userId || !isStaff(role)) return fail("Only admins and teachers can publish tests.");
  const id = Number(formData.get("id"));
  const publish = formData.get("publish") === "1";
  const quiz = Number.isInteger(id)
    ? await prisma.quiz.findUnique({
        where: { id },
        select: { status: true, publishedAt: true, questions: { select: { marks: true } } },
      })
    : null;
  if (!quiz) return fail("That test was removed.");

  if (!publish) {
    if (quiz.status !== "PUBLISHED") return fail("That test isn't published.");
    await prisma.quiz.update({ where: { id }, data: { status: "PENDING" } });
    refresh();
    return done("Unpublished. Learners can't see it until you publish it again.");
  }

  if (quiz.status !== "PENDING") return fail("Only a written test that's waiting for review can be published.");
  const total = quiz.questions.reduce((sum, q) => sum + q.marks, 0);
  if (total < MIN_MARKS || total > MAX_MARKS) {
    return fail(`A test must be out of ${MIN_MARKS} to ${MAX_MARKS} marks; this one is out of ${total}.`);
  }
  await prisma.quiz.update({
    where: { id },
    data: { status: "PUBLISHED", publishedAt: quiz.publishedAt ?? new Date() },
  });
  refresh();
  return done("Published. Learners can take it now.");
};

const questionSchema = z.object({
  id: z.coerce.number().int().min(1),
  question: z.string().trim().min(1, { message: "Write the question." }).max(1000),
  option0: z.string().trim().min(1, { message: "Fill in all four options." }).max(300),
  option1: z.string().trim().min(1, { message: "Fill in all four options." }).max(300),
  option2: z.string().trim().min(1, { message: "Fill in all four options." }).max(300),
  option3: z.string().trim().min(1, { message: "Fill in all four options." }).max(300),
  answer: z.coerce.number().int().min(0).max(3, { message: "Choose the correct option." }),
  explanation: z.string().trim().max(1000).optional().or(z.literal("")),
});

// Once a learner has taken a test its questions are fixed, so every
// learner's marks are for the same test
const editableQuestion = async (questionId: number) => {
  const question = await prisma.quizQuestion.findUnique({
    where: { id: questionId },
    select: { quizId: true, quiz: { select: { status: true, _count: { select: { attempts: true } } } } },
  });
  if (!question) return { error: "That question was removed." } as const;
  if (question.quiz._count.attempts) {
    return { error: "Learners have already taken this test, so it can't be changed." } as const;
  }
  return { question };
};

export const saveQuestion = async (_state: State, formData: FormData): Promise<State> => {
  const { userId, role } = await auth();
  if (!userId || !isStaff(role)) return fail("Only admins and teachers can change tests.");
  const parsed = questionSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Check the question.");
  const d = parsed.data;
  const options = [d.option0, d.option1, d.option2, d.option3];
  if (new Set(options).size < 4) return fail("The four options must all be different.");

  const found = await editableQuestion(d.id);
  if (!("question" in found) || !found.question) return fail(found.error ?? "That question was removed.");
  await prisma.quizQuestion.update({
    where: { id: d.id },
    data: {
      question: d.question,
      options: JSON.stringify(options),
      answer: d.answer,
      explanation: d.explanation || null,
    },
  });
  refresh();
  return done("Saved.");
};

export const deleteQuestion = async (_state: State, formData: FormData): Promise<State> => {
  const { userId, role } = await auth();
  if (!userId || !isStaff(role)) return fail("Only admins and teachers can change tests.");
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return fail("Unknown question.");
  const found = await editableQuestion(id);
  if (!("question" in found) || !found.question) return fail(found.error ?? "That question was removed.");
  const remaining = await prisma.quizQuestion.findMany({
    where: { quizId: found.question.quizId, id: { not: id } },
    select: { marks: true },
  });
  if (remaining.reduce((sum, q) => sum + q.marks, 0) < MIN_MARKS && found.question.quiz.status === "PUBLISHED") {
    return fail(`A published test needs at least ${MIN_MARKS} marks. Unpublish it first.`);
  }
  await prisma.quizQuestion.delete({ where: { id } });
  refresh();
  return done("Question removed.");
};

// A learner hands in a test: it's marked here, never in the browser, and
// each learner gets one go so their readiness reflects what they knew
export const submitTest = async (_state: State, formData: FormData): Promise<State> => {
  const { userId, role } = await auth();
  if (!userId || role !== "student") return fail("Only students can take tests.");
  const quizId = Number(formData.get("quizId"));
  if (!Number.isInteger(quizId)) return fail("Unknown test.");

  const student = await prisma.student.findUnique({ where: { id: userId }, select: learnerSelect });
  if (!student) return fail("Your student account wasn't found.");
  const quiz = await prisma.quiz.findFirst({
    where: { AND: [{ id: quizId }, learnerQuizWhere(student)] },
    select: { questions: { select: { id: true, answer: true, marks: true, options: true } } },
  });
  if (!quiz) return fail("That test isn't available to you.");

  const answers: Record<number, number> = {};
  for (const q of quiz.questions) {
    const chosen = formData.get(`q${q.id}`);
    if (chosen === null) return fail("Answer every question before handing in.");
    const index = Number(chosen);
    if (!Number.isInteger(index) || index < 0 || index >= parseOptions(q.options).length) {
      return fail("Answer every question before handing in.");
    }
    answers[q.id] = index;
  }
  const score = quiz.questions.reduce((sum, q) => sum + (answers[q.id] === q.answer ? q.marks : 0), 0);
  const total = quiz.questions.reduce((sum, q) => sum + q.marks, 0);

  try {
    await prisma.quizAttempt.create({
      data: { quizId, studentId: userId, score, total, answers: JSON.stringify(answers) },
    });
  } catch {
    // The unique index stops a second go, e.g. from a double click
    return fail("You've already handed in this test.");
  }
  refresh();
  return done(`You got ${score} out of ${total}.`);
};

const termSchema = z
  .object({
    name: z.string().trim().min(1, { message: "Name the term, e.g. Term 1 2027." }).max(60),
    startDate: z.coerce.date({ message: "Choose the first day of the term." }),
    endDate: z.coerce.date({ message: "Choose the last day of the term." }),
  })
  .refine((d) => d.endDate > d.startDate, {
    message: "The term must end after it starts.",
    path: ["endDate"],
  });

export const addTerm = async (_state: State, formData: FormData): Promise<State> => {
  const { userId, role } = await auth();
  if (!userId || role !== "admin") return fail("Only admins can set terms.");
  const parsed = termSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Check the term.");
  const { name, startDate } = parsed.data;
  // Include the whole last day
  const endDate = new Date(parsed.data.endDate.getTime() + 24 * 60 * 60 * 1000 - 1);

  const overlap = await prisma.term.findFirst({
    where: { startDate: { lte: endDate }, endDate: { gte: startDate } },
    select: { name: true },
  });
  if (overlap) return fail(`That overlaps ${overlap.name}.`);
  await prisma.term.create({ data: { name, startDate, endDate } });
  revalidatePath("/settings");
  refresh();
  return done("Term added.");
};

export const deleteTerm = async (_state: State, formData: FormData): Promise<State> => {
  const { userId, role } = await auth();
  if (!userId || role !== "admin") return fail("Only admins can set terms.");
  const id = Number(formData.get("id"));
  const { count } = await prisma.term.deleteMany({ where: { id: Number.isInteger(id) ? id : -1 } });
  if (count === 0) return fail("That term was already removed.");
  revalidatePath("/settings");
  refresh();
  return done("Term removed.");
};
