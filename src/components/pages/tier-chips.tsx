import Link from "next/link";
import { cn } from "@/lib/cn";
import { TIERS } from "@/server/domain/tiers";

/** Tier filter chips (`?tier=1..5`, ADR 0017): keep the other query params, drop the tier on «Все». */
export function TierChips({ active, params, base = "" }: { active: number | null; params: Record<string, string | undefined>; base?: string }) {
  const href = (t: number | null) => { const q = new URLSearchParams(params as Record<string, string>); if (t) q.set("tier", String(t)); else q.delete("tier"); return `${base}?${q}`; };
  const chip = (on: boolean) => cn("rounded-full border px-2.5 py-0.5 text-xs", on ? "border-accent bg-accent-soft text-accent" : "border-border text-muted hover:bg-surface-hover");
  return (
    <div className="flex flex-wrap gap-1" data-testid="tier-chips">
      <Link href={href(null)} scroll={false} className={chip(active == null)}>Все тиры</Link>
      {TIERS.map((t) => <Link key={t} href={href(t)} scroll={false} className={chip(active === t)}>T{t}</Link>)}
    </div>
  );
}
