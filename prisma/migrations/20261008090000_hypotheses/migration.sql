-- Hypotheses: stored proposals (nightly rules, alerts, the owner) with a status and a measured result. ADR 0013.
CREATE TYPE "HypothesisSource" AS ENUM ('AUTO', 'ALERT', 'MANUAL');
CREATE TYPE "HypothesisStatus" AS ENUM ('PROPOSED', 'ACCEPTED', 'DONE', 'REJECTED', 'EXPIRED');
CREATE TYPE "HypothesisLevel" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

CREATE TABLE "Hypothesis" (
  "id" TEXT NOT NULL,
  "source" "HypothesisSource" NOT NULL,
  "status" "HypothesisStatus" NOT NULL DEFAULT 'PROPOSED',
  "level" "HypothesisLevel" NOT NULL DEFAULT 'WARNING',
  "ruleKey" TEXT,
  "objectKey" TEXT,
  "scope" TEXT NOT NULL,
  "alertId" TEXT,
  "bundleId" TEXT,
  "siteId" TEXT,
  "format" "AdFormat",
  "zoneId" TEXT,
  "networkId" TEXT,
  "countryCode" TEXT,
  "sourceSlug" TEXT,
  "dealId" TEXT,
  "title" TEXT NOT NULL,
  "hypothesis" TEXT NOT NULL,
  "evidence" JSONB NOT NULL DEFAULT '{}',
  "impactMonth" DECIMAL(12,4),
  "link" TEXT NOT NULL DEFAULT '/hypotheses',
  "metric" TEXT,
  "baseline" DECIMAL(14,6),
  "result" DECIMAL(14,6),
  "resultNote" TEXT,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "acceptedAt" TIMESTAMP(3),
  "closedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Hypothesis_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Hypothesis_ruleKey_objectKey_key" ON "Hypothesis"("ruleKey", "objectKey");
CREATE INDEX "Hypothesis_status_level_idx" ON "Hypothesis"("status", "level");
ALTER TABLE "Hypothesis" ADD CONSTRAINT "Hypothesis_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Hypothesis" ADD CONSTRAINT "Hypothesis_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "Bundle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Read view for the MCP `query` tool: no free text beyond title/hypothesis, which the owner wrote or the rules composed.
CREATE VIEW v_hypotheses AS
SELECT h.id, h.source::text AS source, h.status::text AS status, h.level::text AS level, h."ruleKey" AS rule_key, h.scope,
       h."bundleId" AS bundle_id, h."siteId" AS site_id, s.domain, h.format::text AS format, h."countryCode" AS country_code,
       h.title, h.hypothesis, h."impactMonth" AS impact_month, h.metric, h.baseline, h.result, h."resultNote" AS result_note,
       h."firstSeenAt" AS first_seen_at, h."lastSeenAt" AS last_seen_at, h."acceptedAt" AS accepted_at, h."closedAt" AS closed_at, h.link
FROM "Hypothesis" h LEFT JOIN "Site" s ON s.id = h."siteId";
GRANT SELECT ON v_hypotheses TO mcp_reader;
