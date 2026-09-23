import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  DealRuleError, calcAmount, checkInvoiceAmount, closedPeriods, distribute, effectiveAmount, inGeoScope,
  periodsOverlap, revenueStateOf, statusAfterPayment, weightOf,
} from "@/server/domain/deals";

describe("calcAmount", () => {
  const c = { pageLoads: 2_910_004, impsOwn: 1_284_320, impsReported: 1_402_110, days: 30 };
  it("per payment basis", () => {
    expect(calcAmount("PER_1000_LOADS", "0.8", c).toString()).toBe("2328.0032");
    expect(calcAmount("CPM_OWN", "0.8", c).toString()).toBe("1027.456");
    expect(calcAmount("CPM_ADVERTISER", "0.8", c).toString()).toBe("1121.688");
    expect(calcAmount("CPM_ADVERTISER", "0.8", { ...c, impsReported: null }).toString()).toBe("1027.456");
    expect(calcAmount("FLAT_DAILY", "15", c).toString()).toBe("450");
    expect(calcAmount("FLAT_PERIOD", "300", { ...c, days: 10 }, 30).toString()).toBe("100");
  });
  it("weight follows the basis", () => {
    expect(weightOf("PER_1000_LOADS", { pageLoads: 5, impsOwn: 3 })).toBe(5);
    expect(weightOf("CPM_ADVERTISER", { pageLoads: 5, impsOwn: 3 })).toBe(3);
    expect(weightOf("FLAT_DAILY", { pageLoads: 5, impsOwn: 3 })).toBe(1);
  });
});

describe("distribute", () => {
  const cells = ["2026-09-01", "2026-09-02", "2026-09-03"].map((date) => ({ date, siteId: "s", countryCode: "JP", weight: 1 }));
  it("sums exactly to the period amount; remainder on the last day", () => {
    const out = distribute("100", cells);
    expect(out.reduce((a, c) => a.add(c.amount), new Decimal(0)).toString()).toBe("100");
    expect(out[0].amount.toString()).toBe("33.3333");
    expect(out[2].amount.toString()).toBe("33.3334");
  });
  it("proportional to weights", () => {
    const out = distribute("10", [{ ...cells[0], weight: 3 }, { ...cells[1], weight: 1 }]);
    expect(out.map((c) => c.amount.toString())).toEqual(["7.5", "2.5"]);
  });
  it("even split when all weights are zero; empty input", () => {
    expect(distribute("9", cells.map((c) => ({ ...c, weight: 0 }))).map((c) => c.amount.toString())).toEqual(["3", "3", "3"]);
    expect(distribute("9", [])).toEqual([]);
  });
});

describe("geo scope", () => {
  it("list, all, all-except", () => {
    expect(inGeoScope({ geoScope: [], geoExclude: false }, "JP")).toBe(true);
    expect(inGeoScope({ geoScope: ["JP"], geoExclude: false }, "US")).toBe(false);
    expect(inGeoScope({ geoScope: ["JP"], geoExclude: true }, "US")).toBe(true);
    expect(inGeoScope({ geoScope: ["JP"], geoExclude: true }, "JP")).toBe(false);
  });
});

describe("closedPeriods", () => {
  it("monthly periods up to yesterday", () => {
    expect(closedPeriods({ startsAt: "2026-07-15", endsAt: null, billingPeriod: "MONTH" }, "2026-09-23"))
      .toEqual([{ from: "2026-07-15", to: "2026-07-31" }, { from: "2026-08-01", to: "2026-08-31" }]);
  });
  it("weekly periods end on Sunday; ended deals cut at endsAt", () => {
    expect(closedPeriods({ startsAt: "2026-09-02", endsAt: "2026-09-10", billingPeriod: "WEEK" }, "2026-09-23"))
      .toEqual([{ from: "2026-09-02", to: "2026-09-06" }, { from: "2026-09-07", to: "2026-09-10" }]);
  });
  it("term billing closes only after the deal ends", () => {
    expect(closedPeriods({ startsAt: "2026-09-01", endsAt: null, billingPeriod: "TERM" }, "2026-09-23")).toEqual([]);
    expect(closedPeriods({ startsAt: "2026-09-01", endsAt: "2026-09-20", billingPeriod: "TERM" }, "2026-09-23"))
      .toEqual([{ from: "2026-09-01", to: "2026-09-20" }]);
  });
  it("overlap", () => {
    expect(periodsOverlap({ from: "2026-09-01", to: "2026-09-30" }, { from: "2026-09-30", to: "2026-10-31" })).toBe(true);
    expect(periodsOverlap({ from: "2026-09-01", to: "2026-09-29" }, { from: "2026-09-30", to: "2026-10-31" })).toBe(false);
  });
});

describe("statuses", () => {
  it("revenue state and effective amount", () => {
    expect(revenueStateOf("OPEN")).toBe("FORECAST");
    expect(revenueStateOf("INVOICED")).toBe("INVOICED");
    expect(revenueStateOf("PARTIAL")).toBe("CONFIRMED");
    expect(effectiveAmount({ status: "PARTIAL", amountInvoiced: "100", amountPaid: "80", amountCalculated: "90" }).toString()).toBe("80");
    expect(effectiveAmount({ status: "INVOICED", amountInvoiced: "100", amountPaid: null, amountCalculated: "90" }).toString()).toBe("100");
    expect(effectiveAmount({ status: "OPEN", amountInvoiced: null, amountPaid: null, amountCalculated: "90" }).toString()).toBe("90");
  });
  it("payment rules", () => {
    expect(statusAfterPayment("100", "100", undefined)).toBe("PAID");
    expect(statusAfterPayment("100", "120", undefined)).toBe("PAID");
    expect(statusAfterPayment("100", "60", "open")).toBe("PARTIAL");
    expect(statusAfterPayment("100", "60", "write_off", "скидка за простой")).toBe("WRITTEN_OFF");
    expect(() => statusAfterPayment("100", "60", undefined)).toThrow(DealRuleError);
    expect(() => statusAfterPayment("100", "60", "write_off", " ")).toThrow(/причину/);
  });
  it("invoice override needs a reason", () => {
    expect(() => checkInvoiceAmount("100", "100.005")).not.toThrow();
    expect(() => checkInvoiceAmount("100", "110")).toThrow(/причину/);
    expect(() => checkInvoiceAmount("100", "110", "доп. размещение")).not.toThrow();
  });
});
