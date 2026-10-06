-- A traffic source created from ADOK keeps the default cost share (100%) until the owner confirms it.
ALTER TABLE "CostSource" ADD COLUMN "confirmed" BOOLEAN NOT NULL DEFAULT true;
-- Sources ADOK created so far still carry the default share: mark them unconfirmed so alert 11 asks for it.
UPDATE "CostSource" SET "confirmed" = false WHERE "asgName" IS NOT NULL AND "revShare" = 1 AND slug NOT IN ('tubecrown', 'tubetraffic');
