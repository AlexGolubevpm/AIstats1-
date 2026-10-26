import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { pruneRaw, rawKeyDate, rawKeysToDelete } from "@/server/ingest/raw-retention";
import { LocalRawStore, rawKey } from "@/server/ingest/raw-store";

const TODAY = "2026-10-26";

describe("raw retention (ADR 0019)", () => {
  it("reads the data date of a key, Metrika's from_to included", () => {
    expect(rawKeyDate(rawKey("adspyglass", "country/101", "2026-10-01", "c1"))).toBe("2026-10-01");
    expect(rawKeyDate(rawKey("metrika", "123", "2026-09-30_2026-10-01", "c1"))).toBe("2026-10-01");
    expect(rawKeyDate("raw/other/file.json")).toBeNull();
  });

  it("drops days past 90, keeps only the latest run of a final day, leaves fresh days and dateless keys", () => {
    const k = (cut: string, date: string, run: string) => rawKey("adspyglass", cut, date, run);
    const keys = [
      k("website", "2026-07-27", "c9"), // 91 days ago → gone, even the latest
      k("website", "2026-07-28", "c9"), // exactly 90 → kept
      k("website", "2026-10-01", "c1"), k("website", "2026-10-01", "c2"), k("website", "2026-10-01", "c3"), // final day: c3 stays
      k("country/101", "2026-10-01", "c1"), // another cut of the same day has its own latest
      k("website", "2026-10-24", "c1"), k("website", "2026-10-24", "c2"), // inside the restate window: all stay
      "raw/other/readme.json",
    ];
    expect(rawKeysToDelete(keys, TODAY).sort()).toEqual([k("website", "2026-07-27", "c9"), k("website", "2026-10-01", "c1"), k("website", "2026-10-01", "c2")].sort());
  });

  it("local store gzips on put, reads both gzipped and legacy plain files, lists keys without .gz", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "raw-"));
    const store = new LocalRawStore(dir);
    const key = rawKey("adspyglass", "website", "2026-10-25", "c1");
    await store.put(key, [{ name: "101. a.test", hits: 5 }]);
    expect(existsSync(path.join(dir, key))).toBe(false);
    expect(JSON.parse(gunzipSync(readFileSync(path.join(dir, `${key}.gz`))).toString())).toEqual([{ name: "101. a.test", hits: 5 }]);
    expect(await store.get(key)).toEqual([{ name: "101. a.test", hits: 5 }]);

    const legacy = rawKey("adspyglass", "website", "2026-10-25", "c0");
    writeFileSync(path.join(dir, legacy), JSON.stringify({ old: true }));
    expect(await store.list("raw/adspyglass/website/")).toEqual([legacy, key]);
    expect(await store.get(legacy)).toEqual({ old: true });
  });

  it("pruneRaw compresses legacy files, deletes what retention says and empty day folders", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "raw-"));
    const store = new LocalRawStore(dir);
    const old = rawKey("adspyglass", "website", "2026-06-01", "c1");
    const superseded = rawKey("adspyglass", "website", "2026-10-01", "c1");
    const latest = rawKey("adspyglass", "website", "2026-10-01", "c2");
    for (const k of [old, superseded]) { mkdirSync(path.dirname(path.join(dir, k)), { recursive: true }); writeFileSync(path.join(dir, k), JSON.stringify({ k })); }
    await store.put(latest, { k: latest });

    expect(await pruneRaw(store, TODAY)).toEqual({ deleted: 2, compressed: 2, kept: 1 });
    expect(await store.list("raw/")).toEqual([latest]);
    expect(await store.get(latest)).toEqual({ k: latest });
    expect(existsSync(path.dirname(path.join(dir, old)))).toBe(false); // the emptied day folder is gone
    expect(readdirSync(path.dirname(path.join(dir, latest)))).toEqual(["c2.json.gz"]);
  });
});
