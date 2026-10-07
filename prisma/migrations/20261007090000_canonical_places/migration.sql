-- The place catalog is the owner's fixed list, the same on every site (ADR 0012). Places that were
-- created automatically from site-prefixed zone names ("GX_NTV_A", "HS_OutStream", …) go away;
-- their zones lose the mapping (FK SET NULL) and are re-mapped by type when the worker starts.
-- Places that carry a deal or a manual state are kept: the owner meant them.
DELETE FROM "Placement" p
WHERE p.slug NOT IN ('tablink_1', 'tablink_2', 'tablink_3', 'underplayer', 'video_link_1', 'video_link_2', 'under_bar', 'above_bar', 'welcome_bar',
                     'video_pause_banner', 'pop', 'slider', 'ntv_a', 'ntv_b', 'footer_a', 'footer_b', 'footer_c', 'footer_d', 'outstream', 'invideo', 'push')
  AND NOT EXISTS (SELECT 1 FROM "DealPlace" d WHERE d."placementSlug" = p.slug)
  AND NOT EXISTS (SELECT 1 FROM "SitePlacement" s WHERE s."placementSlug" = p.slug);
-- Zones mapped by the old "place of its own name" rule are re-mapped on the next worker start.
UPDATE "Zone" SET "placementSlug" = NULL
WHERE "placementSlug" IS NOT NULL AND "placementSlug" NOT IN (SELECT slug FROM "Placement");
