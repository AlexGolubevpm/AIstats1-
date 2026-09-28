-- CreateTable
CREATE TABLE "FactRevenueDevice" (
    "date" DATE NOT NULL,
    "siteId" TEXT NOT NULL,
    "device" "Device" NOT NULL,
    "pageLoads" INTEGER NOT NULL DEFAULT 0,
    "impsOwn" INTEGER NOT NULL DEFAULT 0,
    "impsNetwork" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "revenueReported" DECIMAL(12,4) NOT NULL DEFAULT 0,

    CONSTRAINT "FactRevenueDevice_pkey" PRIMARY KEY ("date","siteId","device")
);

-- AddForeignKey
ALTER TABLE "FactRevenueDevice" ADD CONSTRAINT "FactRevenueDevice_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

