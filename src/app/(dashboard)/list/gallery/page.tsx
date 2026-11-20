import Link from "next/link";
import GalleryManager from "@/components/GalleryManager";
import prisma from "@/lib/prisma";

// Admins only (see routeAccessMap): photos for the public website's gallery
const GalleryAdminPage = async () => {
  const photos = await prisma.galleryPhoto.findMany({ orderBy: { createdAt: "desc" } });

  return (
    <div className="card p-4 flex-1 m-4 mt-0">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Gallery</h1>
          <p className="text-xs text-gray-500">
            Photos of classes, events and achievements for the website&apos;s Gallery page.
          </p>
        </div>
        <Link href="/gallery" className="text-sm text-indigo-700 hover:underline">
          View the public gallery →
        </Link>
      </div>
      <GalleryManager
        photos={photos.map((p) => ({ id: p.id, caption: p.caption, category: p.category, createdAt: p.createdAt.toISOString() }))}
      />
    </div>
  );
};

export default GalleryAdminPage;
