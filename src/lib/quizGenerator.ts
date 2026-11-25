import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaContentBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { z } from "zod";
import { readStoredFile } from "./fileStore";
import { gradeLabel } from "./phases";
import prisma from "./prisma";
import { MARKS_PER_QUESTION, MAX_QUESTIONS, MIN_QUESTIONS, TESTED_MATERIAL_TYPES } from "./quizzes";

// Claude writes a multiple-choice test for a lesson video or a study
// material. The test waits as PENDING until a teacher checks and publishes it.

const MODEL = "claude-opus-5-5";

// A test that has been GENERATING this long was cut off (a restart or a
// timeout) and may be written again
const STUCK_MS = 10 * 60 * 1000;

// Claude reads PDFs up to 32 MB per request, and images up to 5 MB; base64
// makes a file a third bigger. Larger files are tested on their title alone.
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

const QuizOutput = z.object({
  title: z.string().describe("A short title for the test, e.g. 'Factors and the HCF: test'"),
  questions: z.array(
    z.object({
      question: z.string(),
      options: z.array(z.string()).describe("Exactly four answer options"),
      answer: z.number().int().describe("Index (0 to 3) of the one correct option"),
      explanation: z.string().describe("One or two sentences on why the answer is correct"),
    })
  ),
});

const SYSTEM = `You write multiple-choice tests for South African school learners, following the CAPS curriculum. Each test checks whether a learner understood one lesson video or one piece of study material, and helps them get ready for their term tests and exams.

Write questions a teacher would be happy to put in front of the class:
- Test what the lesson or material actually teaches, from basic recall to applying the method to a new example. Most questions should need the learner to work something out, not just remember a word.
- Each question has exactly four options and exactly one correct answer. Make the wrong options plausible: use the mistakes learners at this grade really make (sign errors, mixing up HCF and LCM, adding denominators, and so on).
- Work every answer out yourself and check it before writing it down. A wrong answer key is the worst possible mistake.
- Spread the correct answers across the four positions.
- Write for the learner's grade: short sentences, everyday South African English, and units where they matter.
- The test is shown as plain text, so write maths plainly: x^2, 3/4, sqrt(16), 2 x 3, -5. Do not use LaTeX or markdown.
- Each question stands alone: never refer to "the video", "the picture above" or another question.`;

class QuizError extends Error {}

const client = () => {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new QuizError("Tests can't be written yet: ANTHROPIC_API_KEY isn't set for the app.");
  }
  return new Anthropic();
};

const askForQuestions = (subject: string, level: number, about: string) => ({
  type: "text" as const,
  text: `Write a multiple-choice test for ${gradeLabel(level)} ${subject} learners on ${about}.

Write between ${MIN_QUESTIONS} and ${MAX_QUESTIONS} questions (about 15 is good). Every question is worth ${MARKS_PER_QUESTION} marks.`,
});

// What Claude is shown about a video: only its details are stored, so the
// test covers the topic the video teaches
const videoContent = async (videoId: number): Promise<BetaContentBlockParam[]> => {
  const video = await prisma.video.findUnique({ where: { id: videoId } });
  if (!video) throw new QuizError("That video was removed.");
  const topic = [video.topic, video.subtopic].filter(Boolean).join(": ");
  return [
    askForQuestions(
      video.subjectName,
      video.grade,
      `the lesson video "${video.title}"${topic ? ` (${topic})` : ""}. Cover what a short lesson on this topic teaches at this grade, including the worked methods and the common mistakes`
    ),
  ];
};

// What Claude is shown about a material: the file itself when it can read
// it (PDF, picture or text), otherwise its title and description
const materialContent = async (materialId: number): Promise<BetaContentBlockParam[]> => {
  const material = await prisma.material.findUnique({
    where: { id: materialId },
    include: { subject: { select: { name: true } }, grade: { select: { level: true } } },
  });
  if (!material) throw new QuizError("That material was removed.");
  if (!(TESTED_MATERIAL_TYPES as readonly string[]).includes(material.type)) {
    throw new QuizError("Memos don't get a test.");
  }

  const described = `"${material.title}"${material.description ? ` (${material.description})` : ""}`;
  // A material for every grade is pitched at the oldest learners who'd use it
  const level = material.grade?.level ?? 12;
  const blocks: BetaContentBlockParam[] = [];
  const isPdf = material.mimeType === "application/pdf";
  const image = IMAGE_TYPES.find((t) => t === material.mimeType);
  const isText = material.mimeType === "text/plain";
  const limit = isPdf ? MAX_PDF_BYTES : image ? MAX_IMAGE_BYTES : isText ? MAX_PDF_BYTES : 0;

  const bytes = limit && material.size <= limit ? await readStoredFile("materials", material.storedName) : null;
  if (bytes && isPdf) {
    blocks.push({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: Buffer.from(bytes).toString("base64") },
      title: material.title,
    });
  } else if (bytes && image) {
    blocks.push({
      type: "image",
      source: { type: "base64", media_type: image, data: Buffer.from(bytes).toString("base64") },
    });
  } else if (bytes && isText) {
    blocks.push({ type: "text", text: `The material:\n\n${Buffer.from(bytes).toString("utf8")}` });
  }

  blocks.push(
    askForQuestions(
      material.subject.name,
      level,
      bytes
        ? `the ${material.type === "QUESTION_PAPER" ? "question paper" : "study material"} ${described} above. Test the content it covers, not the document itself`
        : `the study material ${described}. The file itself can't be read, so test the topic its title and description name`
    )
  );
  return blocks;
};

const writeQuestions = async (content: BetaContentBlockParam[]) => {
  let response;
  try {
    response = await client().beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      // If a safety check declines a request, Anthropic retries it on its
      // recommended fallback model instead of failing
      fallbacks: "default",
      output_config: { effort: "medium", format: betaZodOutputFormat(QuizOutput) },
      system: SYSTEM,
      messages: [{ role: "user", content }],
    });
  } catch (err) {
    if (err instanceof QuizError) throw err;
    if (err instanceof Anthropic.AuthenticationError) {
      throw new QuizError("The ANTHROPIC_API_KEY was refused. Check it in the app's settings.");
    }
    if (err instanceof Anthropic.RateLimitError) {
      throw new QuizError("Claude is busy right now. Try again in a minute.");
    }
    if (err instanceof Anthropic.APIError) {
      console.log(err);
      throw new QuizError(`Claude couldn't write the test (error ${err.status ?? "unknown"}). Try again.`);
    }
    throw err;
  }

  if (response.stop_reason === "refusal") throw new QuizError("Claude declined to write a test for this.");
  if (response.stop_reason === "max_tokens") throw new QuizError("The test came out too long. Try again.");
  const output = response.parsed_output;
  if (!output) throw new QuizError("Claude's test couldn't be read. Try again.");

  // Questions that don't have four options and one valid answer are left out
  const questions = output.questions
    .map((q) => ({
      question: q.question.trim(),
      options: q.options.map((o) => o.trim()),
      answer: q.answer,
      explanation: q.explanation.trim(),
    }))
    .filter(
      (q) =>
        q.question &&
        q.options.length === 4 &&
        q.options.every(Boolean) &&
        new Set(q.options).size === 4 &&
        Number.isInteger(q.answer) &&
        q.answer >= 0 &&
        q.answer <= 3
    )
    .slice(0, MAX_QUESTIONS);
  if (questions.length < MIN_QUESTIONS) {
    throw new QuizError(`Claude only wrote ${questions.length} usable questions. Try again.`);
  }
  return { title: output.title.trim().slice(0, 150), questions };
};

export type QuizSource = { videoId: number } | { materialId: number };

const sourceWhere = (source: QuizSource) =>
  "videoId" in source ? { videoId: source.videoId } : { materialId: source.materialId };

// Marks the test for a video or material as being written, clearing any
// earlier questions, and returns its id. Quick, so pages can show the new
// status straight away; writeQuiz does the slow part. A test learners have
// already taken is never rewritten, so their marks stay meaningful.
export const startQuiz = async (source: QuizSource): Promise<{ id: number } | { error: string }> => {
  const where = sourceWhere(source);
  const existing = await prisma.quiz.findFirst({
    where,
    select: { id: true, status: true, updatedAt: true, _count: { select: { attempts: true } } },
  });
  if (existing?._count.attempts) {
    return { error: "Learners have already taken this test, so it can't be rewritten." };
  }
  if (existing?.status === "GENERATING" && Date.now() - existing.updatedAt.getTime() < STUCK_MS) {
    return { error: "This test is already being written." };
  }

  const quiz = existing
    ? await prisma.quiz.update({
        where: { id: existing.id },
        data: { status: "GENERATING", error: null, publishedAt: null, questions: { deleteMany: {} } },
      })
    : await prisma.quiz.create({ data: { ...where, title: "Test being written", status: "GENERATING" } });
  return { id: quiz.id };
};

// Has Claude write the questions for a test startQuiz prepared
export const writeQuiz = async (quizId: number, source: QuizSource): Promise<{ ok: boolean; message: string }> => {
  const quiz = { id: quizId };
  try {
    const content = "videoId" in source ? await videoContent(source.videoId) : await materialContent(source.materialId);
    const { title, questions } = await writeQuestions(content);
    await prisma.quiz.update({
      where: { id: quiz.id },
      data: {
        title,
        status: "PENDING",
        questions: {
          create: questions.map((q, i) => ({
            position: i,
            question: q.question,
            options: JSON.stringify(q.options),
            answer: q.answer,
            marks: MARKS_PER_QUESTION,
            explanation: q.explanation || null,
          })),
        },
      },
    });
    return { ok: true, message: "The test is written and waiting for you to check it." };
  } catch (err) {
    if (!(err instanceof QuizError)) console.log(err);
    const message = err instanceof QuizError ? err.message : "Something went wrong writing the test. Try again.";
    await prisma.quiz.update({ where: { id: quiz.id }, data: { status: "FAILED", error: message } }).catch(() => {});
    return { ok: false, message };
  }
};

// Writes a test for a newly published video or uploaded material, unless it
// has one already. Run after the response is sent, so nobody waits for it.
export const ensureQuiz = async (source: QuizSource) => {
  if (await prisma.quiz.findFirst({ where: sourceWhere(source), select: { id: true } })) return;
  const started = await startQuiz(source);
  if ("id" in started) await writeQuiz(started.id, source);
};

// Published videos and testable materials that don't have a test yet
export const missingQuizSources = async (take: number): Promise<QuizSource[]> => {
  const [videos, materials] = await Promise.all([
    prisma.video.findMany({
      where: { status: "PUBLISHED", quiz: null },
      select: { id: true },
      orderBy: { createdAt: "desc" },
      take,
    }),
    prisma.material.findMany({
      where: { type: { in: [...TESTED_MATERIAL_TYPES] }, quiz: null },
      select: { id: true },
      orderBy: { createdAt: "desc" },
      take,
    }),
  ]);
  return [
    ...videos.map((v) => ({ videoId: v.id })),
    ...materials.map((m) => ({ materialId: m.id })),
  ].slice(0, take);
};
