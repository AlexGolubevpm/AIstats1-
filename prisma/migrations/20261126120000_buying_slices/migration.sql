-- ADR 0023 (addendum): CPM bids of traffic sources by tier and cached «format × tiers» slices.
CREATE TABLE "BidRate" (
    "id" TEXT NOT NULL,
    "sourceSlug" TEXT NOT NULL,
    "siteId" TEXT,
    "tier" INTEGER NOT NULL,
    "cpm" DECIMAL(10,4) NOT NULL,
    "loadsPerVisit" DECIMAL(6,2) NOT NULL DEFAULT 1,
    "validFrom" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BidRate_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "BidRate_sourceSlug_tier_validFrom_idx" ON "BidRate"("sourceSlug", "tier", "validFrom");

CREATE TABLE "BuyingSlice" (
    "key" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BuyingSlice_pkey" PRIMARY KEY ("key")
);
CREATE INDEX "BuyingSlice_siteId_idx" ON "BuyingSlice"("siteId");
