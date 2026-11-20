import type { Metadata } from "next";
import Link from "next/link";
import { CtaBand, PageHero, Section } from "@/components/site/SiteBlocks";
import GalleryGrid from "@/components/site/GalleryGrid";
import { GALLERY_CATEGORIES, galleryCategoryLabel, isGalleryCategory } from "@/lib/galleryCategories";
import prisma from "@/lib/prisma";
import { getSettings } from "@/lib/schoolSettings";

export const generateMetadata = async (): Promise<Metadata> => {
  const s = await getSettings();
  return { title: `Gallery · ${s.schoolName}` };
};

const GalleryPage = async ({ searchParams }: { searchParams: Promise<{ album?: string }> }) => {
  const { album } = await searchParams;
  const active = album && isGalleryCategory(album) ? album : null;
  const [settings, photos, counts] = await Promise.all([
    getSettings(),
    prisma.galleryPhoto.findMany({
      where: active ? { category: active } : {},
      orderBy: { createdAt: "desc" },
      select: { id: true, caption: true, category: true },
    }),
    prisma.galleryPhoto.groupBy({ by: ["category"], _count: { _all: true } }),
  ]);
  const countOf = (c: string) => counts.find((x) => x.category === c)?._count._all ?? 0;
  const total = counts.reduce((sum, c) => sum + c._count._all, 0);
  const albums = GALLERY_CATEGORIES.filter((c) => countOf(c.value) > 0);

  const tab = (href: string, label: string, count: number, on: boolean) => (
    <Link
      key={href}
      href={href}
      aria-current={on ? "page" : undefined}
      className={`rounded-full px-4 py-2 text-sm font-medium transition ${
        on ? "bg-[var(--brand)] text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200"
      }`}
    >
      {label} <span className={on ? "text-white/80" : "text-gray-400"}>{count}</span>
    </Link>
  );

  return (
    <>
      <PageHero
        eyebrow="Gallery"
        title={`Life at ${settings.schoolName}`}
        intro="Classes, events and proud moments from our learners and teachers."
      />
      <Section>
        {total === 0 ? (
          <p className="text-center text-gray-500">Photos are coming soon.</p>
        ) : (
          <>
            {albums.length > 1 && (
              <nav aria-label="Albums" className="mb-8 flex flex-wrap gap-2">
                {tab("/gallery", "All", total, !active)}
                {albums.map((c) => tab(`/gallery?album=${c.value}`, c.label, countOf(c.value), active === c.value))}
              </nav>
            )}
            {photos.length === 0 ? (
              <p className="text-gray-500">No photos in this album yet.</p>
            ) : (
              <GalleryGrid
                photos={photos.map((p) => ({ id: p.id, caption: p.caption, album: galleryCategoryLabel(p.category) }))}
              />
            )}
          </>
        )}
      </Section>
      <CtaBand title="Want to be in the next photo?" body="Register online, or contact us if you'd like to talk it through first." />
    </>
  );
};

export default GalleryPage;
