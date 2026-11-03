-- «Что если» optimisations on /forecast (ADR 0020 addendum): a table of their own, never part of the plan or the facts.
-- CreateEnum
CREATE TYPE "WhatIfKind" AS ENUM ('OPEX', 'TRAFFIC_SOURCE', 'TRAFFIC_COST', 'REVENUE', 'OTHER_COST');

-- CreateTable
CREATE TABLE "WhatIf" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" "WhatIfKind" NOT NULL,
    "ref" TEXT,
    "current" DECIMAL(12,2) NOT NULL,
    "target" DECIMAL(12,2) NOT NULL,
    "fromMonth" DATE NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "planItemId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatIf_pkey" PRIMARY KEY ("id")
);

