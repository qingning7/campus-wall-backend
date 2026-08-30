-- CreateTable
CREATE TABLE "WallStroke" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "color" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "points" JSONB NOT NULL,
    "authorId" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,

    CONSTRAINT "WallStroke_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WallStroke_roomId_createdAt_idx" ON "WallStroke"("roomId", "createdAt");

-- CreateIndex
CREATE INDEX "WallStroke_authorId_idx" ON "WallStroke"("authorId");

-- AddForeignKey
ALTER TABLE "WallStroke" ADD CONSTRAINT "WallStroke_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WallStroke" ADD CONSTRAINT "WallStroke_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
