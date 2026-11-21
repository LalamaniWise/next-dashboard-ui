import { randomUUID } from "crypto";
import path from "path";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { deleteFile, saveFile } from "@/lib/fileStore";
import { GALLERY_TYPES, looksLikeImage, MAX_GALLERY_MB } from "@/lib/gallery";
import { isGalleryCategory, MAX_CAPTION } from "@/lib/galleryCategories";
import prisma from "@/lib/prisma";

// Admins add a photo to the website's gallery (one photo per request; the
// form sends several one after another). A route handler, because server
// actions cap request bodies at 1 MB.
export async function POST(request: Request) {
  const fail = (error: string, status = 400) => Response.json({ error }, { status });

  const { userId, role } = await auth();
  if (!userId || role !== "admin") return fail("Only admins can add photos to the gallery.", 403);

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > (MAX_GALLERY_MB + 1) * 1024 * 1024) return fail(`Photos can be at most ${MAX_GALLERY_MB} MB.`, 413);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail("The upload was incomplete. Please try again.");
  }

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return fail("Choose a photo.");
  if (file.size > MAX_GALLERY_MB * 1024 * 1024) return fail(`Photos can be at most ${MAX_GALLERY_MB} MB.`, 413);
  const ext = path.extname(file.name).toLowerCase();
  const mimeType = GALLERY_TYPES[ext];
  if (!mimeType) return fail("Use a JPG, PNG or WebP photo.");

  const category = String(form.get("category") ?? "");
  if (!isGalleryCategory(category)) return fail("Choose an album.");
  const caption = String(form.get("caption") ?? "").trim().replace(/\s+/g, " ");
  if (caption.length > MAX_CAPTION) return fail(`Keep the caption under ${MAX_CAPTION} characters.`);

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!looksLikeImage(bytes, mimeType)) return fail("That file isn't a JPG, PNG or WebP photo.");

  const storedName = `${randomUUID()}${ext === ".jpeg" ? ".jpg" : ext}`;
  await saveFile("gallery", storedName, bytes, mimeType);

  try {
    const photo = await prisma.galleryPhoto.create({
      data: { caption: caption || null, category, storedName, mimeType, size: file.size, uploadedById: userId },
    });
    revalidatePath("/gallery");
    revalidatePath("/list/gallery");
    return Response.json({ id: photo.id }, { status: 201 });
  } catch (err) {
    console.log(err);
    await deleteFile("gallery", storedName);
    return fail("Something went wrong saving the photo.", 500);
  }
}
