-- CreateTable
CREATE TABLE "_GradeToVideo" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL,
    CONSTRAINT "_GradeToVideo_A_fkey" FOREIGN KEY ("A") REFERENCES "Grade" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "_GradeToVideo_B_fkey" FOREIGN KEY ("B") REFERENCES "Video" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Video" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "title" TEXT NOT NULL,
    "youtubeUrl" TEXT NOT NULL,
    "subjectName" TEXT NOT NULL,
    "grade" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Video" ("createdAt", "grade", "id", "subjectName", "title", "youtubeUrl") SELECT "createdAt", "grade", "id", "subjectName", "title", "youtubeUrl" FROM "Video";
DROP TABLE "Video";
ALTER TABLE "new_Video" RENAME TO "Video";
CREATE UNIQUE INDEX "Video_youtubeUrl_key" ON "Video"("youtubeUrl");
CREATE INDEX "Video_status_idx" ON "Video"("status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "_GradeToVideo_AB_unique" ON "_GradeToVideo"("A", "B");

-- CreateIndex
CREATE INDEX "_GradeToVideo_B_index" ON "_GradeToVideo"("B");
