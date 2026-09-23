import { describe, expect, it } from "vitest";
import * as m from "@/lib/metrics";

describe("metrics", () => {
  it("computes ratios per 1000", () => {
    expect(m.revPer1kLoads(12, 4000)).toBe(3);
    expect(m.rpm(50, 10000)).toBe(5);
    expect(m.cpm(2, 1000)).toBe(2);
    expect(m.viewableCpm(3, 500)).toBe(6);
  });

  it("returns null on zero denominators instead of Infinity/NaN", () => {
    for (const v of [m.revPer1kLoads(5, 0), m.rpm(1, 0), m.cpm(1, 0), m.viewRate(1, 0), m.fillRate(1, 0),
      m.discrepancy(0, 5), m.romi(10, 0), m.depth(3, 0), m.share(1, 0), m.costPerUnique(1, 0)]) {
      expect(v).toBeNull();
    }
  });

  it("uses ratio of sums, not average of ratios", () => {
    const rows = [{ rev: 1, loads: 1000 }, { rev: 99, loads: 9000 }];
    const sumRatio = m.revPer1kLoads(rows.reduce((a, r) => a + r.rev, 0), rows.reduce((a, r) => a + r.loads, 0));
    const avgRatio = rows.map((r) => m.revPer1kLoads(r.rev, r.loads)!).reduce((a, b) => a + b) / rows.length;
    expect(sumRatio).toBe(10);
    expect(avgRatio).not.toBe(10);
  });

  it("computes ROMI and margin", () => {
    expect(m.margin(150, 100)).toBe(50);
    expect(m.romi(150, 100)).toBe(50);
    expect(m.romi(80, 100)).toBe(-20);
  });

  it("discrepancy sign: negative when advertiser counts more", () => {
    expect(m.discrepancy(1000, 900)).toBeCloseTo(0.1);
    expect(m.discrepancy(1000, 1300)).toBeCloseTo(-0.3);
    expect(m.discrepancyLevel(0.05)).toBe("ok");
    expect(m.discrepancyLevel(-0.2)).toBe("warning");
    expect(m.discrepancyLevel(-0.3)).toBe("negative");
    expect(m.discrepancyLevel(null)).toBe("ok");
  });

  it("delta: percent for money, percentage points for rates", () => {
    expect(m.delta(110, 100, "percent")).toBeCloseTo(10);
    expect(m.delta(42.5, 40, "pp")).toBeCloseTo(2.5);
    expect(m.delta(5, 0, "percent")).toBeNull();
    expect(m.delta(null, 3, "pp")).toBeNull();
    expect(m.delta(-50, -100, "percent")).toBeCloseTo(50);
  });

  it("heat fill only on >20% deviation", () => {
    expect(m.isNotableDeviation(125, 100)).toBe(true);
    expect(m.isNotableDeviation(115, 100)).toBe(false);
    expect(m.isNotableDeviation(10, 0)).toBe(false);
  });
});
