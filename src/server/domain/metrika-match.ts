// Metrika counters → our sites, by domain (ADR 0018). Pure: the service feeds it the sites and the
// counters the token can see. Only our sites come out; a counter without a site of ours is ignored.
import { normalizeDomain } from "@/server/ingest/normalize";
import type { MetrikaCounter } from "@/server/ingest/metrika/client";

export interface MatchSite { id: string; domain: string; metrikaId: string | null }
export type MatchDecision = "matched" | "same" | "conflict" | "ambiguous" | "none";
export interface MatchRow {
  siteId: string; domain: string; metrikaId: string | null;
  /** Active counters whose site or mirror is this domain. */
  counters: { id: string; name: string; site: string }[];
  decision: MatchDecision;
  /** The counter «Применить» would write: only for `matched`. */
  counterId: string | null;
}

export const DECISION_LABEL: Record<MatchDecision, string> = {
  matched: "привязать", same: "уже привязан", conflict: "другой счётчик у сайта", ambiguous: "несколько счётчиков — выбрать руками", none: "счётчика нет",
};

export function matchCounters(sites: MatchSite[], counters: MetrikaCounter[]): MatchRow[] {
  const byDomain = new Map<string, MetrikaCounter[]>();
  for (const c of counters) {
    if (c.status && c.status.toLowerCase() !== "active") continue; // deleted counters have no data
    const domains = new Set([c.site, ...c.mirrors].map((d) => normalizeDomain(d)).filter(Boolean));
    for (const d of domains) byDomain.set(d, [...(byDomain.get(d) ?? []), c]);
  }
  return sites.map((s) => {
    const found = byDomain.get(normalizeDomain(s.domain)) ?? [];
    const list = found.map((c) => ({ id: c.id, name: c.name, site: c.site }));
    let decision: MatchDecision = "none", counterId: string | null = null;
    if (found.length === 1) {
      if (s.metrikaId === found[0].id) decision = "same";
      else if (s.metrikaId) decision = "conflict";
      else { decision = "matched"; counterId = found[0].id; }
    } else if (found.length > 1) {
      decision = s.metrikaId && found.some((c) => c.id === s.metrikaId) ? "same" : "ambiguous";
    }
    return { siteId: s.id, domain: s.domain, metrikaId: s.metrikaId, counters: list, decision, counterId };
  });
}
