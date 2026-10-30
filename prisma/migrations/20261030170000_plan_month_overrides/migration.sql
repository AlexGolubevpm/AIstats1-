-- The month chain of the plan (ADR 0020 addendum): a month's own figure for a line (rotation, traffic cost,
-- one fix deal); the months after it carry it. Adds a table, touches no data.
CREATE TABLE "PlanMonthOverride" (
    "id" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "line" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "note" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PlanMonthOverride_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlanMonthOverride_month_line_key" ON "PlanMonthOverride"("month", "line");
