// Choices for AI lesson videos. Kept free of server-only imports so the
// Create video form can use them too. The video service checks the same list.

export const LESSON_VIDEO_SUBJECTS = [
  "Mathematics",
  "Mathematical Literacy",
  "Technical Mathematics",
  "Life Sciences",
  "Physical Sciences",
  "Geography",
  "EGD",
  "Accounting",
  "Economics",
  "Business Studies",
  "English",
  "Afrikaans",
] as const;

export const LESSON_VIDEO_GRADES = [8, 9, 10, 11, 12] as const;

// What a lesson can be made from, besides a typed request
export const LESSON_SOURCE_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};
export const MAX_LESSON_SOURCE_MB = 10;

// What can be downloaded from a finished video job
export const LESSON_VIDEO_FILES = {
  video: { label: "Video", suffix: "video.mp4", type: "video/mp4" },
  activity: { label: "Activity PDF", suffix: "activity.pdf", type: "application/pdf" },
  memo: { label: "Memo PDF", suffix: "memo.pdf", type: "application/pdf" },
  cover: { label: "Cover picture", suffix: "cover.jpg", type: "image/jpeg" },
} as const;
export type LessonVideoFile = keyof typeof LESSON_VIDEO_FILES;

export const LESSON_VIDEO_LANGUAGES = [
  { value: "en", label: "English" },
  { value: "af", label: "Afrikaans" },
] as const;

export const LESSON_VIDEO_VOICES = [
  { value: "espeak", label: "Computer voice (free, sounds robotic)" },
  { value: "piper-cori", label: "Cori (British woman, English only)" },
  { value: "piper-northern-male", label: "Northern English man (English only)" },
  { value: "piper", label: "Your trained voice (needs a voice file on the video service)" },
] as const;

export const LESSON_VIDEO_BOARDS = [
  { value: "white", label: "Whiteboard" },
  { value: "black", label: "Chalkboard" },
] as const;

export type VideoJobStatus = "queued" | "writing" | "documents" | "rendering" | "uploading" | "done" | "failed";

// What the progress poll returns to the browser
export type VideoProgress = {
  status: VideoJobStatus | "unreachable";
  step: string;
  title?: string | null;
  privacy?: string | null;
  files?: LessonVideoFile[] | null;
  error?: string | null;
};

export const PROGRESS_POLL_MS = 5000;
