import Link from "next/link";
import GradeResources from "@/components/GradeResources";
import { auth } from "@/lib/auth";
import { gradeLabel, phaseLabels, phaseOf } from "@/lib/phases";
import prisma from "@/lib/prisma";
import { videoGradesFor } from "@/lib/videoService";

// Every grade's lesson videos and study material in one place. Teachers and
// admins can open any grade; learners and parents see only their own grades.
const LearningPage = async ({ searchParams }: { searchParams: Promise<{ [key: string]: string | undefined }> }) => {
  const { userId, role } = await auth();
  const query = await searchParams;
  const own = await videoGradesFor(role, userId);
  const grades = await prisma.grade.findMany({
    where: own ? { level: { in: own } } : {},
    orderBy: { level: "asc" },
    select: { id: true, level: true },
  });

  if (grades.length === 0) {
    return (
      <div className="flex-1 m-4 mt-0 card p-4 text-sm text-gray-500">
        {role === "parent"
          ? "Link your child on your dashboard to see the videos and study material for their grade."
          : "No grades have been set up yet."}
      </div>
    );
  }

  const grade = grades.find((g) => String(g.level) === query.grade) ?? grades[0];
  // Changing grade starts that grade's first video
  const tabHref = (level: number) => `/list/learning?grade=${level}`;
  const phases = (["PRIMARY", "SECONDARY"] as const).filter((p) => grades.some((g) => phaseOf(g.level) === p));

  return (
    <div className="flex-1 m-4 mt-0 flex flex-col gap-4">
      <section className="card p-4 flex flex-col gap-3">
        <div>
          <h1 className="text-lg font-semibold">Learning by grade</h1>
          <p className="text-xs text-gray-500">
            {own
              ? "The lesson videos and study material for your grade, each with a test to check what you learnt."
              : "The lesson videos and study material published to each grade, with their tests."}
          </p>
        </div>
        {grades.length > 1 &&
          phases.map((phase) => (
            <div key={phase} className="flex flex-col gap-1">
              <span className="text-xs font-medium text-gray-500">{phaseLabels[phase]}</span>
              <nav className="flex flex-wrap gap-2" aria-label={phaseLabels[phase]}>
                {grades
                  .filter((g) => phaseOf(g.level) === phase)
                  .map((g) => (
                    <Link
                      key={g.id}
                      href={tabHref(g.level)}
                      aria-current={g.id === grade.id ? "page" : undefined}
                      className={`rounded-full px-3 py-1 text-sm ${
                        g.id === grade.id ? "bg-indigo-500 text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                      }`}
                    >
                      {gradeLabel(g.level)}
                    </Link>
                  ))}
              </nav>
            </div>
          ))}
      </section>
      <GradeResources
        grade={grade}
        role={role}
        userId={userId}
        basePath="/list/learning"
        query={{ grade: String(grade.level), v: query.v }}
      />
    </div>
  );
};

export default LearningPage;
