-- Operating expenses per calendar month, spread evenly over the month's days (ADR 0007).
CREATE TYPE "OpexCategory" AS ENUM ('HOSTING', 'SALARY', 'SOFTWARE', 'CONTENT', 'MARKETING', 'OTHER');

CREATE TABLE "OpexEntry" (
    "id" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "title" TEXT NOT NULL,
    "category" "OpexCategory" NOT NULL DEFAULT 'OTHER',
    "amount" DECIMAL(12,2) NOT NULL,
    "siteId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OpexEntry_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OpexEntry_month_idx" ON "OpexEntry"("month");
ALTER TABLE "OpexEntry" ADD CONSTRAINT "OpexEntry_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One row per day of the entry's month; amount / days in that month, not rounded, so SUM over
-- the month returns the entered figure exactly. site_id NULL = the whole network.
CREATE VIEW v_opex_daily AS
SELECT d::date AS date, e."siteId" AS site_id, e.id AS entry_id, e.category::text AS category, e.title,
       e.amount / extract(day FROM (e.month + interval '1 month - 1 day'))::numeric AS amount
FROM "OpexEntry" e
CROSS JOIN LATERAL generate_series(e.month::timestamp, e.month + interval '1 month - 1 day', interval '1 day') AS d;

GRANT SELECT ON v_opex_daily TO mcp_reader;

-- Traffic sources ADOK reports that are not bought traffic: no cost.
UPDATE "CostSource" SET "revShare" = 0 WHERE slug IN ('organic_se', 'no_source') AND "revShare" = 1;
