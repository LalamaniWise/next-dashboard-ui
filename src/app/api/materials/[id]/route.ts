import { auth } from "@/lib/auth";
import { loadLogo } from "@/lib/brandAssets";
import { openFile } from "@/lib/fileStore";
import { withCoverPage } from "@/lib/materialCover";
import { materialAccessWhere } from "@/lib/materials";
import { isImageType, materialTypeLabels } from "@/lib/materialTypes";
import prisma from "@/lib/prisma";
import { getSettings } from "@/lib/schoolSettings";

// Bigger PDFs are sent as they are, to keep downloads quick on a busy server
const MAX_COVER_BYTES = 30 * 1024 * 1024;

// Downloads a material, checking the signed-in user may see it. Images can
// instead be shown in the browser with ?view=1
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { userId, role } = await auth();
  if (!userId) return new Response("Please sign in.", { status: 401 });

  const access = await materialAccessWhere(role, userId);
  const id = parseInt((await params).id);
  const material =
    access && Number.isInteger(id)
      ? await prisma.material.findFirst({
          where: { AND: [{ id }, access] },
          include: { subject: { select: { name: true } }, grade: { select: { level: true } } },
        })
      : null;
  // Same answer for "doesn't exist" and "not yours" so ids can't be probed
  if (!material) return new Response("Not found.", { status: 404 });

  const file = await openFile("materials", material.storedName);
  if (!file) return new Response("The file is missing on the server.", { status: 410 });

  const inline = isImageType(material.mimeType) && new URL(request.url).searchParams.has("view");
  const ascii = material.fileName.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const headers = {
    "Content-Type": material.mimeType,
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(material.fileName)}`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
  };

  // PDFs get the school's cover page in front (the stored file is unchanged)
  if (material.mimeType === "application/pdf" && file.size <= MAX_COVER_BYTES) {
    const [original, logo, settings] = await Promise.all([
      new Response(file.stream).arrayBuffer().then((b) => new Uint8Array(b)),
      loadLogo(),
      getSettings(),
    ]);
    const covered = await withCoverPage(original, {
      school: settings.schoolName,
      kind: materialTypeLabels[material.type],
      title: material.title,
      description: material.description,
      subject: material.subject.name,
      grade: material.grade?.level ?? null,
      year: material.year,
    }, logo);
    const body = new Uint8Array(covered ?? original);
    return new Response(body, { headers: { ...headers, "Content-Length": String(body.byteLength) } });
  }

  return new Response(file.stream, {
    headers: { ...headers, "Content-Length": String(file.size) },
  });
}
