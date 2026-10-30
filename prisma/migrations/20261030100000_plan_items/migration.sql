-- Planned lines of future months for /forecast «На месяцы вперёд» (ADR 0020). Adds a table, touches no data.
CREATE TYPE "PlanItemKind" AS ENUM ('REVENUE', 'COST');

CREATE TABLE "PlanItem" (
    "id" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "kind" "PlanItemKind" NOT NULL,
    "title" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "siteId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlanItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PlanItem_month_idx" ON "PlanItem"("month");

ALTER TABLE "PlanItem" ADD CONSTRAINT "PlanItem_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
