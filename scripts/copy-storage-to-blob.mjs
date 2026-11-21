// Uploads the files in ./storage (study materials, gallery photos, logo) to
// the private Vercel Blob store, where the app looks for them once
// BLOB_READ_WRITE_TOKEN is set (src/lib/fileStore.ts). Safe to run again.
//
//   node --env-file=.env scripts/copy-storage-to-blob.mjs
import { put } from "@vercel/blob";
import { readdir, readFile } from "fs/promises";
import path from "path";

if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error("Set BLOB_READ_WRITE_TOKEN in .env first (Vercel > Storage > your Blob store).");
  process.exit(1);
}

const DIRS = {
  materials: process.env.MATERIALS_DIR,
  gallery: process.env.GALLERY_DIR,
  branding: process.env.BRANDING_DIR,
};

let count = 0;
for (const [area, dir] of Object.entries(DIRS)) {
  const folder = dir || path.join("storage", area);
  const files = await readdir(folder, { withFileTypes: true }).catch(() => []);
  for (const f of files.filter((f) => f.isFile())) {
    await put(`${area}/${f.name}`, await readFile(path.join(folder, f.name)), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    console.log(`${area}/${f.name}`);
    count++;
  }
}
console.log(`Uploaded ${count} file(s).`);
