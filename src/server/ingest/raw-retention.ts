// Retention of stored raw API responses (ADR 0019). Every run writes its own file, so the hourly totals
// and the nightly restate leave dozens of copies of the same day; only the latest one is ever read
// (rawGeoKeys, siteTotalsFromRaw take the last run of a day), and geo:reprocess looks 90 days back.
import { addDays } from "@/lib/period";
import { LocalRawStore, type RawStore } from "./raw-store";

/** Days a raw response is kept at all: the window of geo:reprocess. */
export const RAW_KEEP_DAYS = 90;
/** After this many days a day is final (past the nightly restate): earlier runs of it are dropped, the latest stays. */
export const RAW_DEDUPE_AFTER_DAYS = 7;

/** The data date of a key `raw/{source}/{cut…}/{date}/{runId}.json`: the last YYYY-MM-DD of the date segment (Metrika stores `from_to`). */
export function rawKeyDate(key: string): string | null {
  const parts = key.split("/");
  const dates = parts[parts.length - 2]?.match(/\d{4}-\d{2}-\d{2}/g);
  return dates ? dates[dates.length - 1] : null;
}

/**
 * Keys to delete on `today`: everything older than RAW_KEEP_DAYS; for days older than
 * RAW_DEDUPE_AFTER_DAYS every run but the latest (run ids are cuids, the lexicographically last is
 * the newest). Keys without a date are left alone.
 */
export function rawKeysToDelete(keys: string[], today: string, keepDays = RAW_KEEP_DAYS, dedupeAfterDays = RAW_DEDUPE_AFTER_DAYS): string[] {
  const dropBefore = addDays(today, -keepDays);
  const finalBefore = addDays(today, -dedupeAfterDays);
  const latest = new Map<string, string>();
  for (const k of keys) {
    const dir = k.slice(0, k.lastIndexOf("/"));
    if (!latest.has(dir) || k > latest.get(dir)!) latest.set(dir, k);
  }
  return keys.filter((k) => {
    const date = rawKeyDate(k);
    if (!date) return false;
    if (date < dropBefore) return true;
    return date < finalBefore && latest.get(k.slice(0, k.lastIndexOf("/"))) !== k;
  });
}

export async function pruneRaw(raw: RawStore, today: string): Promise<{ deleted: number; compressed: number; kept: number }> {
  const compressed = raw instanceof LocalRawStore ? await raw.compressLegacy() : 0;
  const keys = await raw.list("raw/");
  const drop = rawKeysToDelete(keys, today);
  for (const k of drop) await raw.delete(k);
  return { deleted: drop.length, compressed, kept: keys.length - drop.length };
}
