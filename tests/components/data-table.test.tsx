// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cellBackground, formatText, renderCell, toCsv, type Column } from "@/components/data/format-cell";

const replace = vi.fn();
let params = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }), usePathname: () => "/sites", useSearchParams: () => params,
}));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));

const { DataTable } = await import("@/components/data/data-table");

const cols: Column[] = [
  { id: "domain", header: "Сайт", kind: "site" }, { id: "revenue", header: "Выручка", kind: "money" },
  { id: "margin", header: "Маржа", kind: "money", heat: "sign" }, { id: "romi", header: "ROMI", kind: "romi", heat: "vsMean" },
];
const rows = [
  { _key: "a", domain: "a.test", revenue: 100, margin: -5, romi: -4.8 },
  { _key: "b", domain: "b.test", revenue: 300, margin: 120, romi: 66.7, _href: "/sites/b.test" },
  { _key: "c", domain: "c.test", revenue: 200, margin: 20, romi: 11.1 },
];

beforeEach(() => { params = new URLSearchParams(); replace.mockClear(); });
afterEach(cleanup);

describe("format-cell", () => {
  it("formats by kind", () => {
    expect(formatText("money", 1234.5)).toMatch(/1\s?234\.50/);
    expect(formatText("int", null)).toBe("—");
    expect(formatText("multiplier", 1.62)).toContain("1.6");
  });
  it("heat: negative is red, far above mean is green, near mean is plain", () => {
    expect(cellBackground(cols[2], rows[0], null)).toBe("var(--heat-neg)");
    expect(cellBackground(cols[3], rows[1], 24)).toBe("var(--heat-pos)");
    expect(cellBackground(cols[3], rows[2], 11)).toBeUndefined();
  });
  it("dashed forecast cells", () => {
    const { container } = render(<>{renderCell(cols[1], { revenue: 5, _dashed: { revenue: true } })}</>);
    expect(container.innerHTML).toContain("border-dashed");
  });
  it("csv keeps raw numbers and escapes text", () => {
    expect(toCsv(cols.slice(0, 2), [{ domain: 'x,"y"', revenue: 1.5 }])).toBe('Сайт,Выручка\n"x,""y""",1.5');
  });
});

describe("DataTable", () => {
  it("sorts by default column, links first cell, renders totals", () => {
    render(<DataTable id="t" columns={cols} rows={rows} defaultSort={{ id: "revenue", dir: "desc" }} totals={{ domain: "Итого", revenue: 600 }} />);
    const body = screen.getAllByRole("row").slice(1, 4).map((r) => within(r).getAllByRole("cell")[0].textContent);
    expect(body).toEqual(["b.test", "c.test", "a.test"]);
    expect(screen.getByRole("link", { name: "b.test" }).getAttribute("href")).toBe("/sites/b.test");
    expect(screen.getByText("Итого")).toBeTruthy();
  });

  it("header click writes sort to the URL; URL state drives order", () => {
    render(<DataTable id="t" columns={cols} rows={rows} defaultSort={{ id: "revenue", dir: "desc" }} />);
    fireEvent.click(screen.getByText("Маржа"));
    expect(replace).toHaveBeenCalledWith("/sites?t.sort=margin.desc", { scroll: false });
    cleanup();
    params = new URLSearchParams("t.sort=margin.asc");
    render(<DataTable id="t" columns={cols} rows={rows} />);
    expect(within(screen.getAllByRole("row")[1]).getAllByRole("cell")[0].textContent).toBe("a.test");
  });

  it("filters from the URL and paginates", () => {
    params = new URLSearchParams("t.f=loss");
    render(<DataTable id="t" columns={cols} rows={rows} filters={[{ id: "loss", label: "Только убыточные", column: "margin", op: "lt", value: 0 }]} />);
    expect(screen.getAllByRole("row")).toHaveLength(2);
    cleanup();
    params = new URLSearchParams("t.page=2");
    render(<DataTable id="t" columns={cols} rows={rows} pageSize={2} defaultSort={{ id: "revenue", dir: "desc" }} />);
    expect(screen.getByText("3–3 из 3")).toBeTruthy();
  });

  it("shows the empty state", () => {
    render(<DataTable id="t" columns={cols} rows={[]} empty="Ничего нет" />);
    expect(screen.getByText("Ничего нет")).toBeTruthy();
  });
});
