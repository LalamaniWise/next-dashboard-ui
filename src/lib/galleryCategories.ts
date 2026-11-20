// Gallery albums. Kept free of server-only imports so forms can use it too.
export const GALLERY_CATEGORIES = [
  { value: "classes", label: "Classes" },
  { value: "events", label: "Events" },
  { value: "achievements", label: "Achievements" },
  { value: "online", label: "Online lessons" },
  { value: "other", label: "Other" },
] as const;

export type GalleryCategory = (typeof GALLERY_CATEGORIES)[number]["value"];

export const isGalleryCategory = (value: string): value is GalleryCategory =>
  GALLERY_CATEGORIES.some((c) => c.value === value);

export const galleryCategoryLabel = (value: string) =>
  GALLERY_CATEGORIES.find((c) => c.value === value)?.label ?? "Other";

export const MAX_CAPTION = 200;
