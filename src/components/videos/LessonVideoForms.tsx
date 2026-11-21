"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { FormEvent, ReactNode, useActionState, useCallback, useEffect, useState } from "react";
import { toast } from "react-toastify";
import {
  LESSON_SOURCE_TYPES,
  LESSON_VIDEO_BOARDS,
  LESSON_VIDEO_FILES,
  LESSON_VIDEO_GRADES,
  LESSON_VIDEO_LANGUAGES,
  LESSON_VIDEO_SUBJECTS,
  LESSON_VIDEO_VOICES,
  LessonVideoFile,
  MAX_LESSON_SOURCE_MB,
  PROGRESS_POLL_MS,
  VideoProgress,
} from "@/lib/lessonVideoOptions";
import { deleteVideo, publishVideo, saveVideo, videoProgress } from "@/lib/videoActions";

const initial = { success: false, error: false } as {
  success: boolean;
  error: boolean;
  message?: string;
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

// Download links for what a finished job made
// With a caption, also a button to copy it for posting the video on TikTok or Facebook
export const JobDownloads = ({
  jobId,
  files,
  caption,
}: {
  jobId: string;
  files: LessonVideoFile[];
  caption?: string | null;
}) => (
  <div className="flex flex-col gap-2">
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
      {files.map((kind) => (
        <a key={kind} href={`/api/videos/${jobId}/${kind}`} className="text-indigo-600 hover:underline">
          Download {LESSON_VIDEO_FILES[kind].label}
        </a>
      ))}
    </div>
    {caption && files.includes("video") && <ShareCaption caption={caption} />}
  </div>
);

const ShareCaption = ({ caption }: { caption: string }) => {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(caption);
      toast("Caption copied. Paste it when you post the video.");
    } catch {
      toast.error("Couldn't copy. Select the caption and copy it yourself.");
    }
  };
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-gray-600">Share on TikTok or Facebook</summary>
      <div className="mt-2 flex flex-col gap-2 rounded-lg bg-slate-50 p-3">
        <p className="text-xs text-gray-500">
          Download the video, upload it in the TikTok or Facebook app, and paste this caption.
        </p>
        <textarea readOnly value={caption} rows={6} className="form-control text-xs" aria-label="Caption" />
        <button type="button" onClick={copy} className="self-start rounded-md border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-white">
          Copy caption
        </button>
      </div>
    </details>
  );
};

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
  if (progress.status === "done" && progress.privacy === "dry-run") {
    return (
      <div role="status" className="flex flex-col gap-1">
        <p className="text-sm text-green-600">
          Done: &quot;{progress.title}&quot; is ready to download. Test mode: nothing was uploaded to
          YouTube or added to the list.
        </p>
        <JobDownloads jobId={jobId} files={progress.files ?? []} caption={progress.shareCaption} />
      </div>
    );
  }
  if (progress.status === "done") {
    return (
      <div role="status" className="flex flex-col gap-1">
        <p className="text-sm text-green-600">
          Done: &quot;{progress.title}&quot; is on YouTube and in the list below, waiting for an admin to publish it.
          {progress.privacy === "private" && " YouTube has made it private for now (see the note above)."}
        </p>
        <JobDownloads jobId={jobId} files={progress.files ?? []} caption={progress.shareCaption} />
      </div>
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
  const [jobId, setJobId] = useState<string>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const close = () => onClose(!!jobId);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const file = form.get("file");
    const hasFile = file instanceof File && file.size > 0;
    if (!hasFile) form.delete("file");
    if (!hasFile && !String(form.get("topic")).trim()) {
      return setError("Type what the video should explain, or attach a file.");
    }
    if (hasFile && file.size > MAX_LESSON_SOURCE_MB * 1024 * 1024) {
      return setError(`Files can be at most ${MAX_LESSON_SOURCE_MB} MB.`);
    }
    setError(undefined);
    setPending(true);
    try {
      const res = await fetch("/api/videos", { method: "POST", body: form });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.jobId) setJobId(body.jobId);
      else setError(body?.error ?? "The video couldn't be started. Please try again.");
    } catch {
      setError("The video couldn't be started. Check your connection and try again.");
    }
    setPending(false);
  };

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
          Type what to teach, attach a PDF or picture to teach from, or both. AI writes a 4 to 6
          minute lesson that a stick-man teacher explains step by step, plus an activity PDF and a
          memo PDF to download. Check them before you share them. It takes several minutes.
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
          <form onSubmit={submit} className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
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
              <label htmlFor="lv-topic" className={label}>What should the video explain?</label>
              <textarea
                id="lv-topic"
                name="topic"
                rows={3}
                maxLength={1000}
                className="form-control"
                placeholder="e.g. Explain exponent laws step by step with examples"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="lv-cover-topic" className={label}>
                Topic <span className="text-gray-400 font-normal">(on the cover)</span>
              </label>
              <input id="lv-cover-topic" name="coverTopic" maxLength={80} className="form-control" placeholder="e.g. Differential calculus" />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="lv-subtopic" className={label}>
                Subtopic <span className="text-gray-400 font-normal">(on the cover)</span>
              </label>
              <input id="lv-subtopic" name="subtopic" maxLength={120} className="form-control" placeholder="e.g. Stationary points" />
            </div>
            <p className="sm:col-span-2 -mt-2 text-xs text-gray-500">
              Leave these empty and the AI fills them in. The cover shows the school logo, subject, grade, topic and subtopic.
            </p>
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <label htmlFor="lv-file" className={label}>
                PDF or picture <span className="text-gray-400 font-normal">(optional, up to {MAX_LESSON_SOURCE_MB} MB)</span>
              </label>
              <input
                id="lv-file"
                name="file"
                type="file"
                accept={Object.keys(LESSON_SOURCE_TYPES).join(",")}
                className="form-control"
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
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <label htmlFor="lv-board" className={label}>Board</label>
              <select id="lv-board" name="board" defaultValue="white" className="form-control">
                {LESSON_VIDEO_BOARDS.map((b) => (
                  <option key={b.value} value={b.value}>{b.label}</option>
                ))}
              </select>
            </div>
            {error && <p role="alert" className="sm:col-span-2 text-sm text-red-500">{error}</p>}
            <button className="btn-primary sm:col-span-2" disabled={pending}>
              {pending ? "Starting..." : "Create video"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
};

// Removes a video from the app. With decline, an admin turns down a video
// waiting for approval.
export const VideoDelete = ({ id, title, decline = false }: { id: number; title: string; decline?: boolean }) => {
  const [state, action, pending] = useActionState(deleteVideo, initial);

  useEffect(() => {
    if (state.success) toast(state.message);
    else if (state.error) toast.error(state.message);
  }, [state]);

  const question = decline
    ? `Decline "${title}" and remove it from the app? It stays on YouTube.`
    : `Remove "${title}" from the app? It stays on YouTube.`;

  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!confirm(question)) e.preventDefault();
      }}
    >
      <input type="hidden" name="id" value={id} />
      {decline ? (
        <>
          <input type="hidden" name="decline" value="1" />
          <button
            disabled={pending}
            className="rounded-md border border-red-200 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
          >
            Decline
          </button>
        </>
      ) : (
        <button
          title="Remove from the app"
          disabled={pending}
          className="w-7 h-7 flex items-center justify-center rounded-full bg-lamaPurple hover:brightness-95 disabled:opacity-50"
        >
          <Image src="/delete.png" alt="Remove" width={16} height={16} />
        </button>
      )}
    </form>
  );
};

const Dialog = ({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) => (
  <div
    className="fixed inset-0 bg-gray-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
    onClick={(e) => e.target === e.currentTarget && onClose()}
  >
    <div role="dialog" aria-modal="true" className="bg-white p-6 rounded-2xl shadow-xl relative w-full max-w-lg max-h-[90vh] overflow-y-auto">
      <button
        type="button"
        aria-label="Close"
        className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center rounded-full hover:bg-gray-100"
        onClick={onClose}
      >
        ✕
      </button>
      <h2 className="text-lg font-semibold mb-4">{title}</h2>
      {children}
    </div>
  </div>
);

// Closes the dialog and shows a toast once a form's action has worked
const useFormResult = (state: typeof initial, onDone: () => void) => {
  const router = useRouter();
  useEffect(() => {
    if (!state.success) return;
    toast(state.message);
    onDone();
    router.refresh();
  }, [state, onDone, router]);
};

export type EditableVideo = {
  id: number;
  title: string;
  subjectName: string;
  grade: number;
  topic: string | null;
  subtopic: string | null;
};

const VideoForm = ({ video, onDone }: { video?: EditableVideo; onDone: () => void }) => {
  const [state, action, pending] = useActionState(saveVideo, initial);
  useFormResult(state, onDone);

  return (
    <form action={action} className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      {video ? (
        <input type="hidden" name="id" value={video.id} />
      ) : (
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <label htmlFor="vf-url" className={label}>YouTube link</label>
          <input id="vf-url" name="youtubeUrl" required className="form-control" placeholder="https://www.youtube.com/watch?v=..." />
        </div>
      )}
      <div className="flex flex-col gap-1.5 sm:col-span-2">
        <label htmlFor="vf-title" className={label}>Title</label>
        <input id="vf-title" name="title" required maxLength={150} defaultValue={video?.title} className="form-control" />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="vf-subject" className={label}>Subject</label>
        <select id="vf-subject" name="subject" required defaultValue={video?.subjectName ?? ""} className="form-control">
          <option value="" disabled>Select a subject</option>
          {LESSON_VIDEO_SUBJECTS.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="vf-grade" className={label}>Made for</label>
        <select id="vf-grade" name="grade" required defaultValue={video?.grade ?? ""} className="form-control">
          <option value="" disabled>Select a grade</option>
          {LESSON_VIDEO_GRADES.map((g) => (
            <option key={g} value={g}>Grade {g}</option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="vf-topic" className={label}>
          Topic <span className="text-gray-400 font-normal">(on the cover)</span>
        </label>
        <input id="vf-topic" name="topic" maxLength={80} defaultValue={video?.topic ?? ""} className="form-control" placeholder="e.g. Algebra" />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="vf-subtopic" className={label}>
          Subtopic <span className="text-gray-400 font-normal">(on the cover)</span>
        </label>
        <input id="vf-subtopic" name="subtopic" maxLength={120} defaultValue={video?.subtopic ?? ""} className="form-control" placeholder="e.g. Factorising trinomials" />
      </div>
      {state.error && <p role="alert" className="sm:col-span-2 text-sm text-red-500">{state.message}</p>}
      <button className="btn-primary sm:col-span-2" disabled={pending}>
        {pending ? "Saving..." : video ? "Save" : "Add video"}
      </button>
    </form>
  );
};

// Adds an existing YouTube video. It waits for an admin to publish it.
export const VideoAdd = () => {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
        Add YouTube video
      </button>
      {open && (
        <Dialog title="Add a YouTube video" onClose={close}>
          <p className="text-sm text-gray-500 mb-4">Learners see it once an admin publishes it.</p>
          <VideoForm onDone={close} />
        </Dialog>
      )}
    </>
  );
};

export const VideoEdit = ({ video }: { video: EditableVideo }) => {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button
        type="button"
        title="Edit"
        onClick={() => setOpen(true)}
        className="w-7 h-7 flex items-center justify-center rounded-full bg-lamaSky hover:brightness-95"
      >
        <Image src="/update.png" alt="Edit" width={16} height={16} />
      </button>
      {open && (
        <Dialog title="Edit video" onClose={close}>
          <VideoForm video={video} onDone={close} />
        </Dialog>
      )}
    </>
  );
};

// An admin picks the grades that see a video, publishing it if it was waiting
export const VideoPublish = ({
  id,
  title,
  published,
  grades,
  selected,
}: {
  id: number;
  title: string;
  published: boolean;
  grades: { id: number; level: number }[];
  selected: number[];
}) => {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const [state, action, pending] = useActionState(publishVideo, initial);
  useFormResult(state, close);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          published
            ? "rounded-md border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
            : "rounded-md bg-green-600 px-2 py-1 text-xs font-medium text-white hover:bg-green-700"
        }
      >
        {published ? "Grades" : "Approve"}
      </button>
      {open && (
        <Dialog title={published ? "Change who sees this video" : "Approve and publish"} onClose={close}>
          <p className="text-sm text-gray-500 mb-4">
            &quot;{title}&quot; shows for students and parents in the grades you tick.
          </p>
          <form action={action} className="flex flex-col gap-4">
            <input type="hidden" name="id" value={id} />
            <fieldset className="flex flex-wrap gap-3">
              <legend className={`${label} mb-2`}>Grades</legend>
              {grades.map((g) => (
                <label key={g.id} className="flex items-center gap-2 rounded-md border border-gray-200 px-3 py-2 text-sm">
                  <input type="checkbox" name="grades" value={g.id} defaultChecked={selected.includes(g.id)} />
                  Grade {g.level}
                </label>
              ))}
            </fieldset>
            {grades.length === 0 && <p className="text-sm text-gray-500">Add the school&apos;s grades first.</p>}
            {state.error && <p role="alert" className="text-sm text-red-500">{state.message}</p>}
            <button className="btn-primary" disabled={pending || grades.length === 0}>
              {pending ? "Publishing..." : published ? "Save grades" : "Publish"}
            </button>
          </form>
        </Dialog>
      )}
    </>
  );
};
