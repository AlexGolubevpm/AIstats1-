// Column sets shared across pages so the same data looks the same everywhere.
import type { Column } from "@/components/data/format-cell";

export const SITE_COLS: Column[] = [
  { id: "domain", header: "Сайт", kind: "site" }, { id: "uniques", header: "Уники", kind: "int" }, { id: "pageviews", header: "Просмотры", kind: "int" },
  { id: "depth", header: "Глубина", kind: "decimal" }, { id: "revenue", header: "Выручка", kind: "money" }, { id: "cost", header: "Расход", kind: "money" },
  { id: "margin", header: "Маржа", kind: "money", heat: "sign" }, { id: "romi", header: "ROMI", kind: "romi", heat: "vsMean" }, { id: "rpm", header: "RPM/уник", kind: "money" },
];

export const FORMAT_COLS: Column[] = [
  { id: "format", header: "Формат", kind: "text" }, { id: "pageLoads", header: "Page loads", kind: "int" }, { id: "imps", header: "Показы", kind: "int" },
  { id: "fillRate", header: "Fill rate", kind: "percent" }, { id: "cpm", header: "Ср. CPM", kind: "cpm", tooltip: "Сравнивать только внутри формата" },
  { id: "viewRate", header: "View rate", kind: "percent" }, { id: "viewableCpm", header: "Viewable CPM", kind: "cpm" },
  { id: "revenue", header: "Выручка", kind: "money" }, { id: "share", header: "Доля", kind: "share" },
];

export const GEO_COLS: Column[] = [
  { id: "country", header: "Страна", kind: "country" }, { id: "tier", header: "Тир", kind: "int" }, { id: "uniques", header: "Уники", kind: "int" },
  { id: "pageLoads", header: "Page loads", kind: "int" }, { id: "revenue", header: "Выручка", kind: "money" }, { id: "cost", header: "Расход", kind: "money" },
  { id: "margin", header: "Маржа", kind: "money", heat: "sign" }, { id: "romi", header: "ROMI", kind: "romi", heat: "vsMean" },
  { id: "revPer1k", header: "Rev/1000 loads", kind: "cpm" },
];

export const NETWORK_COLS: Column[] = [
  { id: "network", header: "Сетка", kind: "text" }, { id: "pageLoads", header: "Page loads", kind: "int" }, { id: "volShare", header: "Доля объёма", kind: "share" },
  { id: "fillRate", header: "Fill rate", kind: "percent" }, { id: "revPer1k", header: "Rev/1000 loads", kind: "cpm", tooltip: "Основная метрика сравнения сеток" },
  { id: "rank", header: "Ранг по цене", kind: "int" }, { id: "discrepancy", header: "Дискрепанси", kind: "discrepancy" }, { id: "revenue", header: "Выручка", kind: "money" },
];

export const FORMAT_LABEL: Record<string, string> = {
  POPUNDER: "Popunder", BANNER: "Баннер", NATIVE: "Нативка", SLIDER: "Слайдер", OUTSTREAM: "Outstream", INVIDEO: "In-video", INPAGEPUSH: "In-page push", OTHER: "Другое",
};
export const DEVICE_LABEL: Record<string, string> = { DESKTOP: "Десктоп", MOBILE: "Мобильные", TABLET: "Планшеты", TV: "TV", CONSOLE: "Консоли", UNKNOWN: "Не определено" };

/** Maps geo query rows into table rows (country column carries its name for the flag cell). */
export const geoRows = <T extends { country: string; name: string }>(rows: T[]) =>
  rows.map((r) => ({ ...r, country__name: r.name, _key: r.country || r.name }));
