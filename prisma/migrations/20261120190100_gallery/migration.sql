-- CreateTable
CREATE TABLE "GalleryPhoto" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "caption" TEXT,
    "category" TEXT NOT NULL,
    "storedName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "GalleryPhoto_storedName_key" ON "GalleryPhoto"("storedName");

-- CreateIndex
CREATE INDEX "GalleryPhoto_category_idx" ON "GalleryPhoto"("category");
