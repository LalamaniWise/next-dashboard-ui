import Link from "next/link";
import prisma from "@/lib/prisma";

// Dashboard card for admins and teachers: how many lesson videos are waiting
// for approval, and a link to the Videos page to deal with them
const LessonVideosCard = async ({ role }: { role: "admin" | "teacher" }) => {
  const [pending, published] = await Promise.all([
    prisma.video.count({ where: { status: "PENDING" } }),
    prisma.video.count({ where: { status: "PUBLISHED" } }),
  ]);

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Lesson videos</h1>
        <Link href="/list/videos#lesson-videos" className="text-xs text-gray-400 hover:underline">
          View all
        </Link>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-4">
        <div className="rounded-md bg-lamaYellowLight p-3">
          <p className="text-2xl font-semibold">{pending}</p>
          <p className="text-xs text-gray-600">Waiting for approval</p>
        </div>
        <div className="rounded-md bg-lamaSkyLight p-3">
          <p className="text-2xl font-semibold">{published}</p>
          <p className="text-xs text-gray-600">Published</p>
        </div>
      </div>
      {pending > 0 && (
        <Link
          href="/list/videos#lesson-videos"
          className="mt-4 block text-sm font-medium text-indigo-600 hover:underline"
        >
          {role === "admin" ? "Review videos waiting for approval →" : "See videos waiting for an admin →"}
        </Link>
      )}
    </div>
  );
};

export default LessonVideosCard;
