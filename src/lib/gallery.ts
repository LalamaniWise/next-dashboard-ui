import "server-only";
import path from "path";

// Photos for the public website's gallery. Kept outside /public, like the
// study materials, so each copy of the system has its own.
export const galleryDir = () =>
  process.env.GALLERY_DIR || path.join(process.cwd(), "storage", "gallery");

export const galleryPath = (storedName: string) => path.join(galleryDir(), path.basename(storedName));

export const MAX_GALLERY_MB = 8;

// SVG is left out: it can carry scripts
export const GALLERY_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

// Checks the file really is the picture its name says, so nothing else can
// be served from the gallery as an image
export const looksLikeImage = (bytes: Uint8Array, mimeType: string) => {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (mimeType === "image/png") return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  if (mimeType === "image/jpeg") return starts(0xff, 0xd8, 0xff);
  if (mimeType === "image/webp") {
    return starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  }
  return false;
};
