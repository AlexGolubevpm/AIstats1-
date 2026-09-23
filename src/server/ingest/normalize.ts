// Normalisation of raw values coming from AdSpyglass / Metrika / CSV before they reach fact
// tables. Unknown countries never fail a job: they map to XX and are collected for review.

export type DeviceCode = "DESKTOP" | "MOBILE" | "TABLET" | "TV" | "CONSOLE" | "UNKNOWN";
export type FormatCode = "POPUNDER" | "BANNER" | "NATIVE" | "SLIDER" | "OUTSTREAM" | "INVIDEO" | "INPAGEPUSH" | "OTHER";

export interface AliasRow { raw: string; source: string; countryCode: string }
export interface CountryRow { code: string; nameEn: string; nameRu?: string }

const key = (s: string) => s.trim().toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ");

/**
 * Country resolver: ISO code → itself; English name → code; alias (source-specific first,
 * then `*`) → code; otherwise XX, and the raw value is recorded in `unresolved`.
 */
export class CountryResolver {
  private byKey = new Map<string, string>();
  private codes = new Set<string>();
  readonly unresolved = new Map<string, { raw: string; source: string; rows: number }>();

  constructor(countries: CountryRow[], aliases: AliasRow[]) {
    for (const c of countries) {
      this.codes.add(c.code);
      this.byKey.set(`*:${key(c.nameEn)}`, c.code);
      if (c.nameRu) this.byKey.set(`*:${key(c.nameRu)}`, c.code);
    }
    for (const a of aliases) this.byKey.set(`${a.source}:${key(a.raw)}`, a.countryCode);
  }

  resolve(raw: string | null | undefined, source: string): string {
    const v = (raw ?? "").trim();
    if (!v) return this.miss("(empty)", source);
    if (/^[A-Za-z]{2}$/.test(v) && this.codes.has(v.toUpperCase())) return v.toUpperCase();
    const hit = this.byKey.get(`${source}:${key(v)}`) ?? this.byKey.get(`*:${key(v)}`);
    return hit ?? this.miss(v, source);
  }

  private miss(raw: string, source: string): string {
    const k = `${source}:${raw}`;
    const cur = this.unresolved.get(k);
    if (cur) cur.rows++;
    else this.unresolved.set(k, { raw, source, rows: 1 });
    return "XX";
  }
}

const DEVICE_MAP: Record<string, DeviceCode> = {
  desktop: "DESKTOP", pc: "DESKTOP", computer: "DESKTOP",
  mobile: "MOBILE", phone: "MOBILE", smartphone: "MOBILE",
  tablet: "TABLET", tv: "TV", smart_tv: "TV", "smart tv": "TV", console: "CONSOLE",
};

export function normalizeDevice(raw: string | null | undefined): DeviceCode {
  return DEVICE_MAP[(raw ?? "").trim().toLowerCase()] ?? "UNKNOWN";
}

export function normalizeFormat(raw: string | null | undefined): FormatCode {
  const v = (raw ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (!v) return "OTHER";
  if (v.includes("popunder") || v === "pop" || v.includes("popup") || v.includes("tabunder")) return "POPUNDER";
  if (v.includes("inpage") || v.includes("push")) return "INPAGEPUSH";
  if (v.includes("native")) return "NATIVE";
  if (v.includes("slider")) return "SLIDER";
  if (v.includes("outstream")) return "OUTSTREAM";
  if (v.includes("invideo") || v.includes("instream") || v.includes("vast") || v.includes("preroll")) return "INVIDEO";
  if (v.includes("banner") || v.includes("footer") || v.includes("header") || v.includes("sidebar")) return "BANNER";
  return "OTHER";
}

/** "137648. domain.com" → { id: 137648, domain: "domain.com" }. */
export function parseWebsiteName(name: string): { id: number | null; domain: string } {
  const m = name.match(/^(\d+)\.\s*(.+)$/);
  return m ? { id: Number(m[1]), domain: normalizeDomain(m[2]) } : { id: null, domain: normalizeDomain(name) };
}

/** "491410. Banners_Footer_A (domain.com)" → { id, name, domain }. */
export function parseSpotName(name: string): { id: number | null; name: string; domain: string | null } {
  const m = name.match(/^(\d+)\.\s*(.+?)\s*\(([^()]+)\)\s*$/);
  if (m) return { id: Number(m[1]), name: m[2], domain: normalizeDomain(m[3]) };
  const n = name.match(/^(\d+)\.\s*(.+)$/);
  return n ? { id: Number(n[1]), name: n[2], domain: null } : { id: null, name, domain: null };
}

/** Lower-case, strip scheme, www. and trailing slash. */
export function normalizeDomain(raw: string): string {
  return raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
}

/** Zone position guessed from its name; editable in settings. */
export function guessPosition(zoneName: string): string | null {
  const n = zoneName.toLowerCase();
  for (const p of ["footer", "header", "sidebar", "player", "grid", "inline", "top", "bottom"]) if (n.includes(p)) return p;
  return null;
}

/** Seed aliases for oddities already seen in exports (docs/tubestat-spec.md → Нормализация). */
export const SEED_ALIASES: Omit<AliasRow, "source">[] = [
  ["Hashemite Kingdom of Jordan", "JO"], ["Myanmar [Burma]", "MM"], ["Republic of Korea", "KR"],
  ["Republic of Moldova", "MD"], ["Republic of the Congo", "CG"], ["Congo", "CD"], ["Scotland", "GB"],
  ["Åland", "AX"], ["Curaçao", "CW"], ["São Tomé and Príncipe", "ST"], ["East Timor", "TL"],
  ["Macedonia", "MK"], ["Cape Verde", "CV"], ["United States of America", "US"], ["USA", "US"],
  ["UK", "GB"], ["Great Britain", "GB"], ["Russian Federation", "RU"], ["Viet Nam", "VN"],
  ["Iran, Islamic Republic of", "IR"], ["Korea, Republic of", "KR"], ["Czech Republic", "CZ"],
  ["Turkey", "TR"], ["Ivory Coast", "CI"], ["Swaziland", "SZ"], ["Burma", "MM"],
].map(([raw, countryCode]) => ({ raw, countryCode }));
