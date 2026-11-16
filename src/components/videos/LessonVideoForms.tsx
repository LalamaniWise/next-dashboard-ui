"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";
import { toast } from "react-toastify";
import {
  LESSON_VIDEO_GRADES,
  LESSON_VIDEO_LANGUAGES,
  LESSON_VIDEO_SUBJECTS,
  LESSON_VIDEO_VOICES,
  PROGRESS_POLL_MS,
  VideoProgress,
} from "@/lib/lessonVideoOptions";
import { deleteVideo, startVideo, videoProgress } from "@/lib/videoActions";

const initial = { success: false, error: false } as {
  success: boolean;
  error: boolean;
  message?: string;
  jobId?: string;
};

const label = "text-xs font-medium text-gray-600";

// Shown in the form and in ai/service/README.md
export const AuditNotice = () => (
  <div className="rounded-lg bg-lamaYellowLight p-3 text-sm text-gray-700">
    <p className="font-medium">Students may not be able to watch new videos yet</p>
    <p className="mt-1">
      Until the school&apos;s Google Cloud project passes YouTube&apos;s API compliance
      audit, YouTube locks every video uploaded from the app to <b>private</b>, so students
      and parents can&apos;t watch it. After the audit is approved, new videos are
      uploaded as unlisted, and earlier ones can be changed to unlisted in YouTube Studio.
    </p>
  </div>
);

// Follows one video job, asking the server every 5 seconds
export const JobProgress = ({ jobId, initialStep }: { jobId: string; initialStep?: string }) => {
  const router = useRouter();
  const [progress, setProgress] = useState<VideoProgress>({
    status: "queued",
    step: initialStep ?? "Starting...",
  });
  const finished = progress.status === "done" || progress.status === "failed";

  useEffect(() => {
    if (finished) return;
    let cancelled = false;
    const check = async () => {
      const next = await videoProgressSafe(jobId);
      if (cancelled) return;
      setProgress((p) => (next.status === "unreachable" ? { ...p, error: next.error } : next));
      if (next.status === "done") {
        toast(`Video ready: ${next.title ?? "lesson"}`);
        router.refresh();
      } else if (next.status === "failed") {
        router.refresh();
      }
    };
    check();
    const timer = setInterval(check, PROGRESS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [jobId, finished, router]);

  if (progress.status === "failed") {
    return (
      <p role="alert" className="text-sm text-red-500">
        The video couldn&apos;t be made: {progress.error ?? "unknown problem"}
      </p>
    );
  }
  if (progress.status === "done") {
    return (
      <p role="status" className="text-sm text-green-600">
        Done: &quot;{progress.title}&quot; is on YouTube and in the list below.
        {progress.privacy === "private" && " YouTube has made it private for now (see the note above)."}
        {progress.privacy === "dry-run" && " (Dry run: nothing was uploaded; the link is made up.)"}
      </p>
    );
  }
  return (
    <div role="status" className="flex flex-col gap-1 text-sm">
      <div className="flex items-center gap-2 text-gray-700">
        <span className="h-3 w-3 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
        <span>{progress.step}</span>
        {progress.title && <span className="text-gray-500">· {progress.title}</span>}
      </div>
      {progress.error && <p className="text-xs text-red-500">{progress.error} Still trying...</p>}
    </div>
  );
};

// A server action that throws (e.g. the app restarting) shouldn't stop the polling
const videoProgressSafe = async (jobId: string): Promise<VideoProgress> => {
  try {
    return await videoProgress(jobId);
  } catch {
    return { status: "unreachable", step: "", error: "Can't reach the app right now." };
  }
};

// Create video button and dialog. Progress shows in the dialog, and on the
// page after the dialog is closed.
export const LessonVideoCreate = () => {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // A new key gives a fresh form after a video was started
  const [dialogKey, setDialogKey] = useState(0);

  const close = (started: boolean) => {
    setOpen(false);
    if (started) {
      setDialogKey((k) => k + 1);
      router.refresh();
    }
  };

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="btn-primary flex items-center gap-2">
        <Image src="/create.png" alt="" width={14} height={14} />
        Create video
      </button>
      {open && <CreateVideoDialog key={dialogKey} onClose={close} />}
    </>
  );
};

const CreateVideoDialog = ({ onClose }: { onClose: (started: boolean) => void }) => {
  const [state, action, pending] = useActionState(startVideo, initial);
  const jobId = state.success ? state.jobId : undefined;
  const close = () => onClose(!!jobId);

  return (
    <div
      className="fixed inset-0 bg-gray-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={(e) => e.target === e.currentTarget && !pending && close()}
    >
      <div role="dialog" aria-modal="true" className="bg-white p-6 rounded-2xl shadow-xl relative w-full max-w-xl max-h-[90vh] overflow-y-auto">
        <button
          type="button"
          aria-label="Close"
          className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center rounded-full hover:bg-gray-100"
          onClick={close}
        >
          ✕
        </button>
        <h2 className="text-lg font-semibold mb-1">Create a lesson video</h2>
        <p className="text-sm text-gray-500 mb-4">
          AI writes the lesson, the video is rendered with animated working and a voice,
          then uploaded to the school&apos;s YouTube channel. It takes a few minutes.
        </p>
        <AuditNotice />

        {jobId ? (
          <div className="mt-4 flex flex-col gap-3">
            <JobProgress jobId={jobId} />
            <p className="text-xs text-gray-500">
              You can close this window. The video keeps going and its progress shows on the Videos page.
            </p>
          </div>
        ) : (
          <form action={action} className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="lv-subject" className={label}>Subject</label>
              <select id="lv-subject" name="subject" required defaultValue="" className="form-control">
                <option value="" disabled>Select a subject</option>
                {LESSON_VIDEO_SUBJECTS.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="lv-grade" className={label}>Grade</label>
              <select id="lv-grade" name="grade" required defaultValue="" className="form-control">
                <option value="" disabled>Select a grade</option>
                {LESSON_VIDEO_GRADES.map((g) => (
                  <option key={g} value={g}>Grade {g}</option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <label htmlFor="lv-topic" className={label}>Topic</label>
              <input
                id="lv-topic"
                name="topic"
                required
                minLength={3}
                maxLength={200}
                className="form-control"
                placeholder="e.g. Stationary points of a cubic function"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="lv-language" className={label}>Language</label>
              <select id="lv-language" name="language" defaultValue="en" className="form-control">
                {LESSON_VIDEO_LANGUAGES.map((l) => (
                  <option key={l.value} value={l.value}>{l.label}</option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="lv-voice" className={label}>Voice</label>
              <select id="lv-voice" name="voice" defaultValue="espeak" className="form-control">
                {LESSON_VIDEO_VOICES.map((v) => (
                  <option key={v.value} value={v.value}>{v.label}</option>
                ))}
              </select>
            </div>
            {state.error && <p role="alert" className="sm:col-span-2 text-sm text-red-500">{state.message}</p>}
            <button className="btn-primary sm:col-span-2" disabled={pending}>
              {pending ? "Starting..." : "Create video"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
};

export const VideoDelete = ({ id, title }: { id: number; title: string }) => {
  const [state, action, pending] = useActionState(deleteVideo, initial);

  useEffect(() => {
    if (state.success) toast(state.message);
    else if (state.error) toast.error(state.message);
  }, [state]);

  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!confirm(`Remove "${title}" from the app? It stays on YouTube.`)) e.preventDefault();
      }}
    >
      <input type="hidden" name="id" value={id} />
      <button
        title="Remove from the app"
        disabled={pending}
        className="w-7 h-7 flex items-center justify-center rounded-full bg-lamaPurple hover:brightness-95 disabled:opacity-50"
      >
        <Image src="/delete.png" alt="Remove" width={16} height={16} />
      </button>
    </form>
  );
};
