// Country tiers 1–5 as the advertising market (and ADOK) groups them (ADR 0017). The default map
// seeds Country.tier; the owner edits tiers on /settings/geo and those edits are never overwritten.
// Tier 0 is reserved for the service codes XX (unrecognised) and ZZ (no country).
export const TIER_MIN = 1, TIER_MAX = 5;
export const TIERS = [1, 2, 3, 4, 5] as const;
export type Tier = (typeof TIERS)[number];

export const DEFAULT_TIERS: Record<Tier, string[]> = {
  1: ["US", "CA", "GB", "AU", "NZ", "DE", "FR", "NL", "SE", "NO", "DK", "CH", "AT", "FI", "IE", "BE", "JP"],
  2: ["IT", "ES", "PT", "PL", "CZ", "GR", "HU", "SK", "SI", "HR", "RO", "BG", "EE", "LV", "LT", "IL", "KR", "SG", "HK", "TW", "AE", "SA", "QA", "KW", "BH", "OM", "MT", "CY", "LU", "IS"],
  3: ["BR", "MX", "AR", "CL", "CO", "PE", "RU", "UA", "KZ", "TR", "ZA", "TH", "MY", "ID", "PH", "VN", "BY", "RS", "GE", "AM", "AZ", "MD", "UY", "CR", "PA", "DO", "EC", "PR", "MK", "ME", "BA", "AL", "XK"],
  4: ["IN", "PK", "BD", "LK", "NP", "EG", "NG", "MA", "DZ", "TN", "KE", "GH", "CI", "SN", "CM", "TZ", "UG", "ET", "IQ", "IR", "JO", "LB", "UZ", "KG", "TJ", "TM", "MN", "KH", "LA", "MM", "BO", "PY", "VE", "GT", "HN", "SV", "NI", "CU", "JM", "TT", "HT"],
  5: [], // every other real country
};
/** The tier the default map gives a code; 5 for a real country outside the lists, 0 for XX/ZZ. */
export function defaultTier(code: string): number {
  if (code === "XX" || code === "ZZ") return 0;
  for (const t of TIERS) if (DEFAULT_TIERS[t].includes(code)) return t;
  return 5;
}
export const tierLabel = (t: number) => (t > 0 ? `T${t}` : "—");

/**
 * Parses a bulk line like «T2: IT, ES; T3 BR MX» into code → tier. Codes are upper-cased; a code named under two tiers
 * keeps the last one; anything that is not «T<1–5>» or a two-letter code is reported.
 */
export function parseTierBulk(text: string): { tiers: Record<string, number>; bad: string[] } {
  const tiers: Record<string, number> = {}, bad: string[] = [];
  let current: number | null = null;
  for (const tok of text.toUpperCase().split(/[\s,;:]+/).filter(Boolean)) {
    const t = tok.match(/^T([1-5])$/);
    if (t) { current = Number(t[1]); continue; }
    if (/^[A-Z]{2}$/.test(tok) && tok !== "XX" && tok !== "ZZ") { if (current == null) bad.push(tok); else tiers[tok] = current; continue; }
    bad.push(tok);
  }
  return { tiers, bad };
}
