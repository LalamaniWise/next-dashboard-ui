"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "react-toastify";
import { GALLERY_CATEGORIES, galleryCategoryLabel, MAX_CAPTION } from "@/lib/galleryCategories";

export type ManagedPhoto = { id: number; caption: string | null; category: string; createdAt: string };

const MAX_MB = 8;
const ACCEPT = ".jpg,.jpeg,.png,.webp";

// Admins add photos (several at once, sent one by one) and remove them
const GalleryManager = ({ photos }: { photos: ManagedPhoto[] }) => {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState<number | null>(null);

  const upload = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const files = (fileRef.current?.files ? Array.from(fileRef.current.files) : []).filter((f) => f.size > 0);
    if (files.length === 0) return toast.error("Choose one or more photos.");
    const tooBig = files.find((f) => f.size > MAX_MB * 1024 * 1024);
    if (tooBig) return toast.error(`${tooBig.name} is over ${MAX_MB} MB.`);

    let added = 0;
    for (const [i, file] of files.entries()) {
      setBusy(`Uploading ${i + 1} of ${files.length}...`);
      const body = new FormData();
      body.set("file", file);
      body.set("caption", String(data.get("caption") ?? ""));
      body.set("category", String(data.get("category") ?? ""));
      const res = await fetch("/api/gallery", { method: "POST", body }).catch(() => null);
      if (res?.ok) added++;
      else toast.error(`${file.name}: ${(await res?.json().catch(() => null))?.error ?? "upload failed"}`);
    }
    setBusy(null);
    if (added) {
      toast.success(`${added} photo${added === 1 ? "" : "s"} added to the gallery.`);
      form.reset();
      router.refresh();
    }
  };

  const remove = async (id: number) => {
    if (removing) return;
    setRemoving(id);
    const res = await fetch(`/api/gallery/${id}`, { method: "DELETE" }).catch(() => null);
    setRemoving(null);
    if (!res?.ok) return toast.error((await res?.json().catch(() => null))?.error ?? "Couldn't remove the photo.");
    toast.success("Photo removed.");
    router.refresh();
  };

  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={upload} className="grid gap-4 rounded-xl border border-gray-200 p-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <label htmlFor="g-files" className="text-xs text-gray-500">
            Photos <span className="text-gray-400">(JPG, PNG or WebP, up to {MAX_MB} MB each; you can choose several)</span>
          </label>
          <input id="g-files" ref={fileRef} type="file" accept={ACCEPT} multiple required className="form-control" />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="g-category" className="text-xs text-gray-500">Album</label>
          <select id="g-category" name="category" required defaultValue="classes" className="form-control">
            {GALLERY_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="g-caption" className="text-xs text-gray-500">
            Caption <span className="text-gray-400">(optional, used for every photo you choose)</span>
          </label>
          <input id="g-caption" name="caption" maxLength={MAX_CAPTION} className="form-control" placeholder="e.g. Grade 12 maths revision camp" />
        </div>
        <p className="sm:col-span-2 text-xs text-gray-500">
          Photos appear on the public website straight away. Only add photos of learners whose parents have agreed.
        </p>
        <button className="btn-primary sm:col-span-2" disabled={!!busy}>{busy ?? "Add to gallery"}</button>
      </form>

      {photos.length === 0 ? (
        <p className="text-sm text-gray-500">No photos yet. Add some above and they&apos;ll show on the website&apos;s Gallery page.</p>
      ) : (
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
          {photos.map((p) => (
            <li key={p.id} className="overflow-hidden rounded-xl border border-gray-200 bg-white">
              <div className="relative aspect-[4/3] bg-gray-100">
                <Image src={`/api/gallery/${p.id}`} alt={p.caption ?? ""} fill unoptimized className="object-cover" />
              </div>
              <div className="flex flex-col gap-1 p-3">
                <span className="text-xs font-medium text-indigo-700">{galleryCategoryLabel(p.category)}</span>
                <p className="text-sm text-gray-800 line-clamp-2 min-h-[2.5rem]">{p.caption || <span className="text-gray-400">No caption</span>}</p>
                <button
                  type="button"
                  onClick={() => remove(p.id)}
                  disabled={removing === p.id}
                  className="mt-1 self-start rounded-md border border-red-200 px-2.5 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50"
                >
                  {removing === p.id ? "Removing..." : "Remove"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default GalleryManager;
