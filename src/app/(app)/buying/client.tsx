"use client";
// «Закупка T1/T2»: site and target margin pickers (URL params) and the ADOK filter check.
import { useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { checkBuyingFiltersAction } from "@/server/actions/buying";

export function BuyingControls({ sites, site, margin }: { sites: { id: string; domain: string }[]; site: string; margin: number }) {
  const router = useRouter(), path = usePathname(), sp = useSearchParams();
  const go = (k: string, v: string) => { const q = new URLSearchParams(sp.toString()); q.set(k, v); router.push(`${path}?${q}`); };
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <Select aria-label="Сайт" value={site} onChange={(e) => go("site", e.target.value)} className="w-auto" data-testid="buying-site">
        {sites.map((s) => <option key={s.id} value={s.domain}>{s.domain}</option>)}
      </Select>
      <label className="flex items-center gap-2">целевая маржа
        <Input aria-label="Целевая маржа, %" type="number" min={0} max={90} step={5} defaultValue={margin} className="h-8 w-20" data-testid="buying-margin"
          onBlur={(e) => e.target.value !== String(margin) && go("margin", e.target.value)} onKeyDown={(e) => e.key === "Enter" && go("margin", (e.target as HTMLInputElement).value)} />%
      </label>
    </div>
  );
}

type Try = { what: "popunder" | "t12"; param: string; kind: string; ok: boolean; why: string };
export function CheckFilters({ siteId }: { siteId: string }) {
  const [pending, start] = useTransition();
  const [tried, setTried] = useState<Try[] | null>(null);
  const toast = useToast();
  const run = () => start(async () => {
    const r = await checkBuyingFiltersAction(siteId);
    if (r.error) return toast(r.error, "error");
    setTried((r.data?.tried as Try[]) ?? []);
    toast(r.message ?? "Готово");
  });
  return (
    <div className="flex flex-col gap-2">
      <Button size="sm" disabled={pending} onClick={run} data-testid="buying-check">{pending ? "Проверяем ADOK…" : "Проверить фильтры ADOK"}</Button>
      {tried && (
        <table className="w-full text-xs" data-testid="buying-tried">
          <tbody>{tried.map((t, i) => (
            <tr key={i} className="border-b border-border/60">
              <td className="py-1 pr-2">{t.what === "popunder" ? "Попсы по странам" : "Источники на T1/T2"}</td>
              <td className="py-1 pr-2 font-mono">{t.kind}</td>
              <td className={t.ok ? "py-1 text-positive" : "py-1 text-muted"}>{t.ok ? "✓ " : "✗ "}{t.why}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}
