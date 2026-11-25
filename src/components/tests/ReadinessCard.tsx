import Link from "next/link";
import { currentTerm, QuizLearner, readinessBand, termReadiness } from "@/lib/quizzes";

// A learner's readiness for this term's tests and exams, from the
// multiple-choice tests on their lesson videos and study materials
const ReadinessCard = async ({ students, title = "Term readiness" }: { students: QuizLearner[]; title?: string }) => {
  if (students.length === 0) return null;
  const term = await currentTerm();

  return (
    <section className="card p-4 flex flex-col gap-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">{title}</h2>
          <p className="text-xs text-gray-500">
            {term
              ? `${term.name}: marks from every test published this term. Tests not taken count as 0.`
              : "Shows once the school has set this year's term dates."}
          </p>
        </div>
        <Link href="/list/tests" className="shrink-0 text-xs text-indigo-600 hover:underline">
          Tests
        </Link>
      </div>
      {term &&
        (await Promise.all(students.map(async (s) => ({ s, r: await termReadiness(s, term) })))).map(({ s, r }) => (
          <div key={s.id} className="flex flex-col gap-3">
            {students.length > 1 && (
              <p className="text-sm font-medium text-gray-900">
                {s.name} {s.surname}
              </p>
            )}
            {r.percent === null ? (
              <p className="text-sm text-gray-500">No tests have been published for this term yet.</p>
            ) : (
              <>
                <div className="flex items-end gap-3">
                  <span className="text-4xl font-semibold text-gray-900">{r.percent}%</span>
                  <span className={`mb-1 rounded-full px-2 py-0.5 text-xs font-medium ${readinessBand(r.percent).style}`}>
                    {readinessBand(r.percent).label}
                  </span>
                </div>
                <p className="text-xs text-gray-500">
                  {r.earned} of {r.total} marks · {r.taken} of {r.tests} test{r.tests === 1 ? "" : "s"} taken
                </p>
                <ul className="flex flex-col gap-2">
                  {r.subjects.map((sub) => (
                    <li key={sub.name} className="flex flex-col gap-1">
                      <div className="flex justify-between text-xs text-gray-600">
                        <span>{sub.name}</span>
                        <span>{sub.percent}%</span>
                      </div>
                      <div
                        className="h-2 rounded-full bg-gray-100"
                        role="progressbar"
                        aria-label={`${sub.name} readiness`}
                        aria-valuenow={sub.percent}
                        aria-valuemin={0}
                        aria-valuemax={100}
                      >
                        <div className="h-2 rounded-full bg-indigo-500" style={{ width: `${sub.percent}%` }} />
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        ))}
    </section>
  );
};

export default ReadinessCard;
