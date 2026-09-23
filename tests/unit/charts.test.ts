import { describe, expect, it } from "vitest";
import { OTHER, colorFor, pivot } from "@/lib/charts";

describe("pivot", () => {
  it("keeps top series and folds the rest into Прочее; missing days stay empty", () => {
    const rows = ["a", "b", "c"].flatMap((k, i) => [{ date: "d1", key: k, value: 10 - i }]);
    const { data, series } = pivot(rows, ["d1", "d2"], 2);
    expect(series).toEqual(["a", OTHER]);
    expect(data[0]).toEqual({ date: "d1", a: 10, [OTHER]: 17 });
    expect(data[1]).toEqual({ date: "d2" });
  });
  it("colors: known first, palette next, grey for Прочее", () => {
    expect(colorFor("x", 0, { x: "#000" })).toBe("#000");
    expect(colorFor(OTHER, 3)).toBe("#94A3B8");
    expect(colorFor("y", 1)).toBe("#A78BFA");
  });
});
