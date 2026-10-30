-- Planned lines with a start, a length and a reason (ADR 0020 addendum): a cost cut (SAVING), repeating every
-- month (recurring, optionally up to untilMonth), linked to the hypothesis that should bring it. Adds columns only.
ALTER TYPE "PlanItemKind" ADD VALUE IF NOT EXISTS 'SAVING';

ALTER TABLE "PlanItem" ADD COLUMN "recurring" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "untilMonth" DATE,
  ADD COLUMN "hypothesisId" TEXT;

ALTER TABLE "PlanItem" ADD CONSTRAINT "PlanItem_hypothesisId_fkey" FOREIGN KEY ("hypothesisId") REFERENCES "Hypothesis"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "PlanItem_hypothesisId_idx" ON "PlanItem"("hypothesisId");
