"use client";

import Image from "next/image";
import { useCallback, useEffect, useState } from "react";

export type GalleryItem = { id: number; caption: string | null; album: string };

// The public photo grid. Tapping a photo opens it full screen; arrows (or
// the keyboard) move between photos, Esc closes.
const GalleryGrid = ({ photos }: { photos: GalleryItem[] }) => {
  const [open, setOpen] = useState<number | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const step = useCallback(
    (by: number) => setOpen((i) => (i === null ? i : (i + by + photos.length) % photos.length)),
    [photos.length]
  );

  useEffect(() => {
    if (open === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight") step(1);
      else if (e.key === "ArrowLeft") step(-1);
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [open, close, step]);

  const current = open === null ? null : photos[open];

  return (
    <>
      <ul className="columns-2 gap-4 sm:columns-3 lg:columns-4 [&>li]:mb-4">
        {photos.map((p, i) => (
          <li key={p.id} className="break-inside-avoid">
            <button
              type="button"
              onClick={() => setOpen(i)}
              className="group block w-full overflow-hidden rounded-2xl bg-gray-100 text-left focus:outline-none focus-visible:ring-4 focus-visible:ring-[var(--brand)]/40"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/gallery/${p.id}`}
                alt={p.caption ?? `${p.album} photo`}
                loading="lazy"
                className="w-full transition duration-300 group-hover:scale-[1.03]"
              />
              {p.caption && <span className="block px-3 py-2 text-sm text-gray-700">{p.caption}</span>}
            </button>
          </li>
        ))}
      </ul>

      {current && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={current.caption ?? "Photo"}
          className="fixed inset-0 z-50 flex flex-col bg-black/90"
          onClick={close}
        >
          <div className="flex items-center justify-between p-3 text-sm text-white/80">
            <span>
              {open! + 1} / {photos.length} · {current.album}
            </span>
            <button type="button" onClick={close} className="rounded-full px-3 py-1.5 text-white hover:bg-white/10" aria-label="Close">
              ✕
            </button>
          </div>
          <div className="relative flex-1" onClick={(e) => e.stopPropagation()}>
            <Image src={`/api/gallery/${current.id}`} alt={current.caption ?? ""} fill unoptimized className="object-contain" />
            {photos.length > 1 && (
              <>
                <button type="button" onClick={() => step(-1)} aria-label="Previous photo"
                  className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-white/15 px-4 py-3 text-2xl text-white hover:bg-white/25">
                  ‹
                </button>
                <button type="button" onClick={() => step(1)} aria-label="Next photo"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-white/15 px-4 py-3 text-2xl text-white hover:bg-white/25">
                  ›
                </button>
              </>
            )}
          </div>
          {current.caption && <p className="p-4 text-center text-white" onClick={(e) => e.stopPropagation()}>{current.caption}</p>}
        </div>
      )}
    </>
  );
};

export default GalleryGrid;
