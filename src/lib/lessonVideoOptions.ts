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

export const LESSON_VIDEO_GRADES = [10, 11, 12] as const;

export const LESSON_VIDEO_LANGUAGES = [
  { value: "en", label: "English" },
  { value: "af", label: "Afrikaans" },
] as const;

export const LESSON_VIDEO_VOICES = [
  { value: "espeak", label: "Computer voice (free, sounds robotic)" },
  { value: "piper", label: "Piper voice (needs a voice file on the video service)" },
] as const;

export type VideoJobStatus = "queued" | "writing" | "rendering" | "uploading" | "done" | "failed";

// What the progress poll returns to the browser
export type VideoProgress = {
  status: VideoJobStatus | "unreachable";
  step: string;
  title?: string | null;
  privacy?: string | null;
  error?: string | null;
};

export const PROGRESS_POLL_MS = 5000;
