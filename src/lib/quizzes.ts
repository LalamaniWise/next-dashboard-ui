import "server-only";
import { Prisma } from "@prisma/client";
import { learnerWhere } from "./materials";
import prisma from "./prisma";

// Each question is worth this many marks, and a test has 10 to 20 of them,
// so every test is out of 20 to 40
export const MARKS_PER_QUESTION = 2;
export const MIN_QUESTIONS = 10;
export const MAX_QUESTIONS = 20;

// Memos are the answers to a question paper, so they don't get a test
export const TESTED_MATERIAL_TYPES = ["STUDY_MATERIAL", "QUESTION_PAPER", "PICTURE"] as const;

export const parseOptions = (options: string): string[] => {
  try {
    const list = JSON.parse(options);
    return Array.isArray(list) ? list.map(String) : [];
  } catch {
    return [];
  }
};

export type QuizLearner = {
  id: string;
  name: string;
  surname: string;
  gradeId: number;
  grade: { level: number };
  subjects: { subjectId: number }[];
};

export const learnerSelect = {
  id: true,
  name: true,
  surname: true,
  gradeId: true,
  grade: { select: { level: true } },
  subjects: { select: { subjectId: true } },
} as const;

// Published tests a learner may take: those for videos published to their
// grade, and for materials they can download
export const learnerQuizWhere = (student: QuizLearner): Prisma.QuizWhereInput => ({
  status: "PUBLISHED",
  OR: [
    { video: { status: "PUBLISHED", grades: { some: { level: student.grade.level } } } },
    { material: learnerWhere(student) },
  ],
});

// The students whose tests the user can see: a student themself, or a
// parent's children. Staff get null, meaning every test.
export const quizLearnersFor = async (
  role: string | undefined,
  userId: string | null
): Promise<QuizLearner[] | null> => {
  if (role === "admin" || role === "teacher") return null;
  if (!userId) return [];
  if (role === "student") {
    return prisma.student.findMany({ where: { id: userId }, select: learnerSelect });
  }
  if (role === "parent") {
    return prisma.student.findMany({
      where: { parentId: userId },
      select: learnerSelect,
      orderBy: { name: "asc" },
    });
  }
  return [];
};

// The term running today, or the last one that has started
export const currentTerm = async () =>
  (await prisma.term.findFirst({
    where: { startDate: { lte: new Date() }, endDate: { gte: new Date() } },
    orderBy: { startDate: "desc" },
  })) ??
  (await prisma.term.findFirst({
    where: { startDate: { lte: new Date() } },
    orderBy: { startDate: "desc" },
  }));

export type Readiness = {
  earned: number;
  total: number;
  // null when no tests were published in the term
  percent: number | null;
  taken: number;
  tests: number;
  subjects: { name: string; earned: number; total: number; percent: number }[];
};

const percentOf = (earned: number, total: number) => Math.round((earned / total) * 100);

// How ready a learner is for the term's tests and exams: the marks they got
// out of the marks for every test published to them that term. Tests they
// haven't taken count as zero, so the figure only reaches 100% when they've
// done all the work.
export const termReadiness = async (
  student: QuizLearner,
  term: { startDate: Date; endDate: Date }
): Promise<Readiness> => {
  const quizzes = await prisma.quiz.findMany({
    where: {
      AND: [learnerQuizWhere(student), { publishedAt: { gte: term.startDate, lte: term.endDate } }],
    },
    select: {
      video: { select: { subjectName: true } },
      material: { select: { subject: { select: { name: true } } } },
      questions: { select: { marks: true } },
      attempts: { where: { studentId: student.id }, select: { score: true } },
    },
  });

  const bySubject = new Map<string, { earned: number; total: number }>();
  let earned = 0;
  let total = 0;
  let taken = 0;
  for (const q of quizzes) {
    const marks = q.questions.reduce((sum, question) => sum + question.marks, 0);
    if (marks === 0) continue;
    const score = q.attempts[0]?.score ?? 0;
    if (q.attempts.length) taken++;
    earned += score;
    total += marks;
    const name = q.video?.subjectName ?? q.material?.subject.name ?? "Other";
    const subject = bySubject.get(name) ?? { earned: 0, total: 0 };
    subject.earned += score;
    subject.total += marks;
    bySubject.set(name, subject);
  }

  return {
    earned,
    total,
    percent: total ? percentOf(earned, total) : null,
    taken,
    tests: quizzes.length,
    subjects: [...bySubject.entries()]
      .map(([name, s]) => ({ name, ...s, percent: percentOf(s.earned, s.total) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
};

// Words for a readiness figure, so learners and parents know what it means
export const readinessBand = (percent: number) =>
  percent >= 80
    ? { label: "Ready", style: "bg-green-100 text-green-800" }
    : percent >= 60
    ? { label: "Nearly ready", style: "bg-lamaSkyLight text-sky-800" }
    : percent >= 40
    ? { label: "Needs more work", style: "bg-lamaYellowLight text-amber-800" }
    : { label: "Not ready yet", style: "bg-red-100 text-red-700" };
