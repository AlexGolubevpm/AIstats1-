-- CreateEnum
CREATE TYPE "SiteStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "AdFormat" AS ENUM ('POPUNDER', 'BANNER', 'NATIVE', 'SLIDER', 'OUTSTREAM', 'INVIDEO', 'INPAGEPUSH', 'OTHER');

-- CreateEnum
CREATE TYPE "NetworkKind" AS ENUM ('MEDIATED', 'DIRECT', 'MARKETPLACE');

-- CreateEnum
CREATE TYPE "Device" AS ENUM ('DESKTOP', 'MOBILE', 'TABLET', 'TV', 'CONSOLE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "RateModel" AS ENUM ('CPM', 'CPC', 'CPU', 'FLAT');

-- CreateEnum
CREATE TYPE "CostOrigin" AS ENUM ('RATE', 'IMPORT');

-- CreateEnum
CREATE TYPE "PaymentBasis" AS ENUM ('PER_1000_LOADS', 'CPM_ADVERTISER', 'CPM_OWN', 'FLAT_DAILY', 'FLAT_PERIOD');

-- CreateEnum
CREATE TYPE "BillingPeriod" AS ENUM ('MONTH', 'WEEK', 'TERM');

-- CreateEnum
CREATE TYPE "CounterSource" AS ENUM ('ASG_ZONE', 'METRIKA', 'MANUAL');

-- CreateEnum
CREATE TYPE "BilledVia" AS ENUM ('DIRECT', 'VIA_ASG');

-- CreateEnum
CREATE TYPE "DealStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ENDED');

-- CreateEnum
CREATE TYPE "DealPeriodStatus" AS ENUM ('OPEN', 'INVOICED', 'PAID', 'PARTIAL', 'DISPUTED', 'WRITTEN_OFF');

-- CreateEnum
CREATE TYPE "RevenueState" AS ENUM ('FORECAST', 'INVOICED', 'CONFIRMED');

-- CreateEnum
CREATE TYPE "AlertLevel" AS ENUM ('WARNING', 'CRITICAL');

-- CreateTable
CREATE TABLE "Site" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "adsgSiteId" INTEGER,
    "metrikaId" TEXT,
    "status" "SiteStatus" NOT NULL DEFAULT 'ACTIVE',
    "launchedAt" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Site_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bundle" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "color" TEXT NOT NULL,

    CONSTRAINT "Bundle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BundleSite" (
    "bundleId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,

    CONSTRAINT "BundleSite_pkey" PRIMARY KEY ("bundleId","siteId")
);

-- CreateTable
CREATE TABLE "Country" (
    "code" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameRu" TEXT NOT NULL,
    "tier" INTEGER NOT NULL,

    CONSTRAINT "Country_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "CountryAlias" (
    "raw" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,

    CONSTRAINT "CountryAlias_pkey" PRIMARY KEY ("source","raw")
);

-- CreateTable
CREATE TABLE "UnresolvedAlias" (
    "raw" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "rows" INTEGER NOT NULL DEFAULT 0,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UnresolvedAlias_pkey" PRIMARY KEY ("source","raw")
);

-- CreateTable
CREATE TABLE "Zone" (
    "id" TEXT NOT NULL,
    "adsgZoneId" INTEGER NOT NULL,
    "siteId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "format" "AdFormat" NOT NULL,
    "position" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Zone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Network" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "kind" "NetworkKind" NOT NULL DEFAULT 'MEDIATED',
    "showInLegend" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 100,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Network_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FactRevenueGeo" (
    "date" DATE NOT NULL,
    "siteId" TEXT NOT NULL,
    "networkId" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "device" "Device" NOT NULL,
    "pageLoads" INTEGER NOT NULL DEFAULT 0,
    "impsOwn" INTEGER NOT NULL DEFAULT 0,
    "impsNetwork" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "revenueReported" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "revenueConfirmed" DECIMAL(12,4),

    CONSTRAINT "FactRevenueGeo_pkey" PRIMARY KEY ("date","siteId","networkId","countryCode","device")
);

-- CreateTable
CREATE TABLE "FactRevenueZone" (
    "date" DATE NOT NULL,
    "siteId" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "format" "AdFormat" NOT NULL,
    "pageLoads" INTEGER NOT NULL DEFAULT 0,
    "impsOwn" INTEGER NOT NULL DEFAULT 0,
    "impsNetwork" INTEGER NOT NULL DEFAULT 0,
    "views" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "revenueReported" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "revenueConfirmed" DECIMAL(12,4),

    CONSTRAINT "FactRevenueZone_pkey" PRIMARY KEY ("date","zoneId")
);

-- CreateTable
CREATE TABLE "FactTraffic" (
    "date" DATE NOT NULL,
    "siteId" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "device" "Device" NOT NULL,
    "uniques" INTEGER NOT NULL DEFAULT 0,
    "pageviews" INTEGER NOT NULL DEFAULT 0,
    "sessions" INTEGER NOT NULL DEFAULT 0,
    "bounceRate" DECIMAL(5,2),
    "avgDepth" DECIMAL(6,2),

    CONSTRAINT "FactTraffic_pkey" PRIMARY KEY ("date","siteId","countryCode","device")
);

-- CreateTable
CREATE TABLE "CostSource" (
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,

    CONSTRAINT "CostSource_pkey" PRIMARY KEY ("slug")
);

-- CreateTable
CREATE TABLE "FactCost" (
    "date" DATE NOT NULL,
    "siteId" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "sourceSlug" TEXT NOT NULL,
    "uniquesBought" INTEGER NOT NULL DEFAULT 0,
    "rateModel" "RateModel" NOT NULL,
    "rate" DECIMAL(10,5) NOT NULL,
    "cost" DECIMAL(12,4) NOT NULL,
    "origin" "CostOrigin" NOT NULL DEFAULT 'RATE',
    "importBatchId" TEXT,

    CONSTRAINT "FactCost_pkey" PRIMARY KEY ("date","siteId","countryCode","sourceSlug")
);

-- CreateTable
CREATE TABLE "CostRate" (
    "id" TEXT NOT NULL,
    "siteId" TEXT,
    "countryCode" TEXT,
    "sourceSlug" TEXT NOT NULL,
    "rateModel" "RateModel" NOT NULL,
    "rate" DECIMAL(10,5) NOT NULL,
    "validFrom" DATE NOT NULL,
    "validTo" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CostRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Advertiser" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contact" TEXT,

    CONSTRAINT "Advertiser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deal" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "advertiserId" TEXT NOT NULL,
    "format" "AdFormat" NOT NULL,
    "paymentBasis" "PaymentBasis" NOT NULL DEFAULT 'PER_1000_LOADS',
    "price" DECIMAL(12,5) NOT NULL,
    "geoScope" TEXT[],
    "geoExclude" BOOLEAN NOT NULL DEFAULT false,
    "startsAt" DATE NOT NULL,
    "endsAt" DATE,
    "billingPeriod" "BillingPeriod" NOT NULL DEFAULT 'MONTH',
    "paymentTermsDays" INTEGER NOT NULL DEFAULT 30,
    "counterSource" "CounterSource" NOT NULL DEFAULT 'ASG_ZONE',
    "billedVia" "BilledVia" NOT NULL DEFAULT 'DIRECT',
    "status" "DealStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Deal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealSite" (
    "dealId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "zoneId" TEXT,

    CONSTRAINT "DealSite_pkey" PRIMARY KEY ("dealId","siteId")
);

-- CreateTable
CREATE TABLE "DealPeriod" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "siteId" TEXT,
    "from" DATE NOT NULL,
    "to" DATE NOT NULL,
    "impsReported" INTEGER,
    "amountCalculated" DECIMAL(12,4),
    "amountInvoiced" DECIMAL(12,4),
    "overrideReason" TEXT,
    "invoiceNo" TEXT,
    "dueAt" DATE,
    "amountPaid" DECIMAL(12,4),
    "paidAt" DATE,
    "writeOffReason" TEXT,
    "status" "DealPeriodStatus" NOT NULL DEFAULT 'OPEN',
    "version" INTEGER NOT NULL DEFAULT 1,
    "supersededById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DealPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FactFixDeal" (
    "date" DATE NOT NULL,
    "dealId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "pageLoads" INTEGER NOT NULL DEFAULT 0,
    "impsOwn" INTEGER NOT NULL DEFAULT 0,
    "impsReported" INTEGER NOT NULL DEFAULT 0,
    "revenue" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "revenueState" "RevenueState" NOT NULL DEFAULT 'FORECAST',
    "dealPeriodId" TEXT,

    CONSTRAINT "FactFixDeal_pkey" PRIMARY KEY ("date","dealId","siteId","countryCode")
);

-- CreateTable
CREATE TABLE "AsgPayout" (
    "month" DATE NOT NULL,
    "amountReported" DECIMAL(12,4) NOT NULL,
    "amountReceived" DECIMAL(12,4) NOT NULL,
    "receivedAt" DATE NOT NULL,
    "note" TEXT,

    CONSTRAINT "AsgPayout_pkey" PRIMARY KEY ("month")
);

-- CreateTable
CREATE TABLE "IngestRun" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "job" TEXT NOT NULL,
    "dateFrom" DATE NOT NULL,
    "dateTo" DATE NOT NULL,
    "status" TEXT NOT NULL,
    "rowsUpsert" INTEGER NOT NULL DEFAULT 0,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "rawKey" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "IngestRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "rule" TEXT NOT NULL,
    "entityKey" TEXT NOT NULL,
    "level" "AlertLevel" NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "link" TEXT NOT NULL,
    "siteId" TEXT,
    "moneyAtRisk" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "payload" JSONB NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "snoozedUntil" TIMESTAMP(3),
    "snoozedRisk" DECIMAL(12,4),
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "rows" INTEGER NOT NULL,
    "total" DECIMAL(14,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revertedAt" TIMESTAMP(3),

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "before" TEXT,
    "after" TEXT,
    "reason" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "Site_domain_key" ON "Site"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "Site_adsgSiteId_key" ON "Site"("adsgSiteId");

-- CreateIndex
CREATE INDEX "Site_status_idx" ON "Site"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Bundle_slug_key" ON "Bundle"("slug");

-- CreateIndex
CREATE INDEX "BundleSite_siteId_idx" ON "BundleSite"("siteId");

-- CreateIndex
CREATE INDEX "Country_tier_idx" ON "Country"("tier");

-- CreateIndex
CREATE UNIQUE INDEX "Zone_adsgZoneId_key" ON "Zone"("adsgZoneId");

-- CreateIndex
CREATE INDEX "Zone_siteId_format_idx" ON "Zone"("siteId", "format");

-- CreateIndex
CREATE UNIQUE INDEX "Network_slug_key" ON "Network"("slug");

-- CreateIndex
CREATE INDEX "FactRevenueGeo_date_siteId_idx" ON "FactRevenueGeo"("date", "siteId");

-- CreateIndex
CREATE INDEX "FactRevenueGeo_date_countryCode_idx" ON "FactRevenueGeo"("date", "countryCode");

-- CreateIndex
CREATE INDEX "FactRevenueZone_date_siteId_idx" ON "FactRevenueZone"("date", "siteId");

-- CreateIndex
CREATE INDEX "FactTraffic_date_siteId_idx" ON "FactTraffic"("date", "siteId");

-- CreateIndex
CREATE INDEX "FactCost_date_siteId_idx" ON "FactCost"("date", "siteId");

-- CreateIndex
CREATE INDEX "FactCost_importBatchId_idx" ON "FactCost"("importBatchId");

-- CreateIndex
CREATE INDEX "CostRate_sourceSlug_validFrom_idx" ON "CostRate"("sourceSlug", "validFrom");

-- CreateIndex
CREATE UNIQUE INDEX "Advertiser_name_key" ON "Advertiser"("name");

-- CreateIndex
CREATE UNIQUE INDEX "DealPeriod_supersededById_key" ON "DealPeriod"("supersededById");

-- CreateIndex
CREATE INDEX "DealPeriod_dealId_from_idx" ON "DealPeriod"("dealId", "from");

-- CreateIndex
CREATE INDEX "FactFixDeal_date_siteId_idx" ON "FactFixDeal"("date", "siteId");

-- CreateIndex
CREATE INDEX "IngestRun_source_startedAt_idx" ON "IngestRun"("source", "startedAt");

-- CreateIndex
CREATE INDEX "Alert_resolvedAt_level_idx" ON "Alert"("resolvedAt", "level");

-- CreateIndex
CREATE UNIQUE INDEX "Alert_rule_entityKey_key" ON "Alert"("rule", "entityKey");

-- CreateIndex
CREATE INDEX "AuditLog_entity_entityId_at_idx" ON "AuditLog"("entity", "entityId", "at");

-- AddForeignKey
ALTER TABLE "BundleSite" ADD CONSTRAINT "BundleSite_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "Bundle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BundleSite" ADD CONSTRAINT "BundleSite_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CountryAlias" ADD CONSTRAINT "CountryAlias_countryCode_fkey" FOREIGN KEY ("countryCode") REFERENCES "Country"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Zone" ADD CONSTRAINT "Zone_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FactRevenueGeo" ADD CONSTRAINT "FactRevenueGeo_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FactRevenueGeo" ADD CONSTRAINT "FactRevenueGeo_networkId_fkey" FOREIGN KEY ("networkId") REFERENCES "Network"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FactRevenueZone" ADD CONSTRAINT "FactRevenueZone_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FactRevenueZone" ADD CONSTRAINT "FactRevenueZone_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FactTraffic" ADD CONSTRAINT "FactTraffic_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FactCost" ADD CONSTRAINT "FactCost_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FactCost" ADD CONSTRAINT "FactCost_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_advertiserId_fkey" FOREIGN KEY ("advertiserId") REFERENCES "Advertiser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealSite" ADD CONSTRAINT "DealSite_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealSite" ADD CONSTRAINT "DealSite_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealSite" ADD CONSTRAINT "DealSite_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealPeriod" ADD CONSTRAINT "DealPeriod_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealPeriod" ADD CONSTRAINT "DealPeriod_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "DealPeriod"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FactFixDeal" ADD CONSTRAINT "FactFixDeal_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FactFixDeal" ADD CONSTRAINT "FactFixDeal_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FactFixDeal" ADD CONSTRAINT "FactFixDeal_dealPeriodId_fkey" FOREIGN KEY ("dealPeriodId") REFERENCES "DealPeriod"("id") ON DELETE SET NULL ON UPDATE CASCADE;
