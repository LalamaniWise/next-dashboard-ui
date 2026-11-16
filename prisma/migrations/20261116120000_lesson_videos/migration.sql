-- CreateTable
CREATE TABLE "Video" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "title" TEXT NOT NULL,
    "youtubeUrl" TEXT NOT NULL,
    "subjectName" TEXT NOT NULL,
    "grade" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "Video_youtubeUrl_key" ON "Video"("youtubeUrl");

-- CreateIndex
CREATE INDEX "Video_grade_idx" ON "Video"("grade");

