import Link from "next/link";
import { notFound } from "next/navigation";
import GradeResources from "@/components/GradeResources";
import { auth } from "@/lib/auth";
import { gradeLabel } from "@/lib/phases";
import prisma from "@/lib/prisma";

const timeText = (d: Date) =>
  d.toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit", hour12: false });

// A timetable lesson with the videos, study material and tests for its
// subject and its class's grade
const LessonPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | undefined }>;
}) => {
  const { userId, role } = await auth();
  const id = Number((await params).id);
  if (!Number.isInteger(id) || !userId) notFound();

  const lesson = await prisma.lesson.findUnique({
    where: { id },
    include: {
      subject: { select: { id: true, name: true } },
      class: { select: { id: true, name: true, grade: { select: { id: true, level: true } } } },
      teacher: { select: { name: true, surname: true } },
    },
  });
  if (!lesson) notFound();

  // Students see lessons of their own class; parents those of their children's classes
  if (role === "student" || role === "parent") {
    const inClass = await prisma.student.count({
      where: {
        classId: lesson.classId,
        ...(role === "student" ? { id: userId } : { parentId: userId }),
      },
    });
    if (!inClass) notFound();
  } else if (role !== "admin" && role !== "teacher") {
    notFound();
  }

  const query = await searchParams;
  const day = lesson.day.charAt(0) + lesson.day.slice(1).toLowerCase();

  return (
    <div className="flex-1 m-4 mt-0 flex flex-col gap-4">
      <section className="card p-4 flex flex-col gap-1">
        <Link href="/list/lessons" className="text-xs text-gray-500 hover:text-gray-700">
          ← All lessons
        </Link>
        <h1 className="text-lg font-semibold">{lesson.name}</h1>
        <p className="text-sm text-gray-600">
          {lesson.subject.name} · Class {lesson.class.name} · {gradeLabel(lesson.class.grade.level)}
        </p>
        <p className="text-xs text-gray-500">
          {day} {timeText(lesson.startTime)} to {timeText(lesson.endTime)} · {lesson.teacher.name} {lesson.teacher.surname}
        </p>
      </section>
      <GradeResources
        grade={lesson.class.grade}
        subject={lesson.subject}
        role={role}
        userId={userId}
        basePath={`/list/lessons/${lesson.id}`}
        query={{ v: query.v }}
      />
    </div>
  );
};

export default LessonPage;
