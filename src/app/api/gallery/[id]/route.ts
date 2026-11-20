import { readFile, unlink } from "fs/promises";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { galleryPath } from "@/lib/gallery";
import prisma from "@/lib/prisma";

const photoId = async (params: Promise<{ id: string }>) => {
  const id = Number((await params).id);
  return Number.isInteger(id) && id > 0 ? id : null;
};

// The photo itself. The gallery is public, so no sign-in is needed.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = await photoId(params);
  const photo = id ? await prisma.galleryPhoto.findUnique({ where: { id } }) : null;
  if (!photo) return new Response("Not found.", { status: 404 });

  const data = await readFile(galleryPath(photo.storedName)).catch(() => null);
  if (!data) return new Response("The photo is missing on the server.", { status: 410 });

  return new Response(new Uint8Array(data), {
    headers: {
      "Content-Type": photo.mimeType,
      "Content-Length": String(data.byteLength),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'",
      "Cache-Control": "public, max-age=86400",
    },
  });
}

// Admins remove a photo (the database row and the file)
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { role } = await auth();
  if (role !== "admin") return Response.json({ error: "Only admins can remove photos." }, { status: 403 });

  const id = await photoId(params);
  const photo = id ? await prisma.galleryPhoto.findUnique({ where: { id } }) : null;
  if (!photo) return Response.json({ error: "That photo was already removed." }, { status: 404 });

  await prisma.galleryPhoto.delete({ where: { id: photo.id } });
  await unlink(galleryPath(photo.storedName)).catch(() => {});
  revalidatePath("/gallery");
  revalidatePath("/list/gallery");
  return Response.json({ ok: true });
}
