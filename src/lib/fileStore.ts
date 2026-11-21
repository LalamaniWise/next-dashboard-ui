import "server-only";
import { del, get, put } from "@vercel/blob";
import { createReadStream } from "fs";
import { mkdir, readFile, stat, unlink, writeFile } from "fs/promises";
import path from "path";
import { Readable } from "stream";

// Where uploaded files (study materials, gallery photos, the school logo)
// are kept. On a normal server they go in ./storage (or the *_DIR folders).
// Hosts without a lasting disk, like Vercel, set BLOB_READ_WRITE_TOKEN to
// keep them in a private Vercel Blob store instead. Either way they're only
// ever served through the app's own routes, which check access first.

export type FileArea = "materials" | "gallery" | "branding";

const DIR_ENV: Record<FileArea, string> = {
  materials: "MATERIALS_DIR",
  gallery: "GALLERY_DIR",
  branding: "BRANDING_DIR",
};

const usesBlob = () => !!process.env.BLOB_READ_WRITE_TOKEN;

const areaDir = (area: FileArea) =>
  process.env[DIR_ENV[area]] || path.join(process.cwd(), "storage", area);

// basename() keeps a stored name from reaching outside its folder
const diskPath = (area: FileArea, name: string) => path.join(areaDir(area), path.basename(name));
const blobPath = (area: FileArea, name: string) => `${area}/${path.basename(name)}`;

export const saveFile = async (area: FileArea, name: string, bytes: Uint8Array, contentType: string) => {
  if (usesBlob()) {
    await put(blobPath(area, name), Buffer.from(bytes), {
      access: "private",
      contentType,
      addRandomSuffix: false,
    });
    return;
  }
  await mkdir(areaDir(area), { recursive: true });
  await writeFile(diskPath(area, name), bytes);
};

// The file as a stream, or null when it's missing
export const openFile = async (
  area: FileArea,
  name: string
): Promise<{ stream: ReadableStream<Uint8Array>; size: number } | null> => {
  if (usesBlob()) {
    const found = await get(blobPath(area, name), { access: "private" }).catch(() => null);
    return found?.statusCode === 200 ? { stream: found.stream, size: found.blob.size } : null;
  }
  const file = diskPath(area, name);
  const info = await stat(file).catch(() => null);
  if (!info) return null;
  return { stream: Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>, size: info.size };
};

export const readStoredFile = async (area: FileArea, name: string): Promise<Uint8Array | null> => {
  if (usesBlob()) {
    const file = await openFile(area, name);
    return file ? new Uint8Array(await new Response(file.stream).arrayBuffer()) : null;
  }
  const bytes = await readFile(diskPath(area, name)).catch(() => null);
  return bytes ? new Uint8Array(bytes) : null;
};

// Never throws: a file that's already gone is fine
export const deleteFile = async (area: FileArea, name: string) => {
  try {
    if (usesBlob()) await del(blobPath(area, name));
    else await unlink(diskPath(area, name));
  } catch {}
};
