"use client";
// «Окупаемость закупки»: pickers kept in the URL (site, source, formats, tiers, margin), the exact
// calculation in ADOK, the ADOK filter check and the bids of the sources.
import { useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ActionForm, FormField } from "@/components/forms/action-form";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { checkBuyingFiltersAction, computeSliceAction, deleteBidAction, saveBidAction } from "@/server/actions/buying";

const chip = (on: boolean) => cn("rounded-full border px-2.5 py-0.5 text-xs", on ? "border-accent bg-accent-soft text-accent" : "border-border text-muted hover:bg-surface-hover");

export function BuyingControls({ sites, site, sources, source, formats, formatOptions, tiers, margin }: {
  sites: { id: string; domain: string }[]; site: string; sources: { slug: string; title: string }[]; source: string;
  formats: string[] | null; formatOptions: { id: string; label: string }[]; tiers: number[]; margin: number;
}) {
  const router = useRouter(), path = usePathname(), sp = useSearchParams();
  const go = (k: string, v: string | null) => { const q = new URLSearchParams(sp.toString()); if (v) q.set(k, v); else q.delete(k); router.push(`${path}?${q}`, { scroll: false }); };
  const toggle = <T,>(xs: T[], x: T) => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x]);
  return (
    <div className="card flex flex-col gap-3 p-4 text-sm" data-testid="buying-controls">
      <div className="flex flex-wrap items-center gap-3">
        <Select aria-label="Сайт" value={site} onChange={(e) => go("site", e.target.value)} className="w-auto" data-testid="buying-site">
          {sites.map((s) => <option key={s.id} value={s.domain}>{s.domain}</option>)}
        </Select>
        <Select aria-label="Источник трафика" value={source} onChange={(e) => go("src", e.target.value === "paid" ? null : e.target.value)} className="w-auto" data-testid="buying-source">
          <option value="paid">Все платные источники</option>
          {sources.map((s) => <option key={s.slug} value={s.slug}>{s.title}</option>)}
        </Select>
        <label className="flex items-center gap-2">целевая маржа
          <Input aria-label="Целевая маржа, %" type="number" min={0} max={90} step={5} defaultValue={margin} className="h-8 w-20" data-testid="buying-margin"
            onBlur={(e) => e.target.value !== String(margin) && go("margin", e.target.value)} onKeyDown={(e) => e.key === "Enter" && go("margin", (e.target as HTMLInputElement).value)} />%
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-1" data-testid="buying-formats">
        <span className="mr-1 text-xs text-muted">Форматы</span>
        <button type="button" className={chip(!formats)} onClick={() => go("fmt", null)}>Все</button>
        {formatOptions.map((f) => (
          <button key={f.id} type="button" className={chip(Boolean(formats?.includes(f.id)))} onClick={() => go("fmt", toggle(formats ?? [], f.id).join(",") || null)}>{f.label}</button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1" data-testid="buying-tiers">
        <span className="mr-1 text-xs text-muted">Тиры</span>
        {[1, 2, 3, 4, 5].map((t) => (
          <button key={t} type="button" className={chip(tiers.includes(t))} onClick={() => { const next = toggle(tiers, t).sort(); if (next.length) go("tiers", next.join(",")); }}>T{t}</button>
        ))}
      </div>
    </div>
  );
}

export function ComputeSlice({ sel, cached }: { sel: { siteId: string; from: string; to: string; formats: string[] | null; tiers: number[] }; cached: boolean }) {
  const [pending, start] = useTransition();
  const toast = useToast();
  const run = () => start(async () => { const r = await computeSliceAction(sel); r.error ? toast(r.error, "error") : toast(r.message ?? "Готово"); });
  return <Button size="sm" variant="primary" disabled={pending} onClick={run} data-testid="buying-compute">{pending ? "Считаем в ADOK…" : cached ? "Пересчитать в ADOK" : "Посчитать точно в ADOK"}</Button>;
}

type Try = { what: "popunder" | "t12" | "both"; param: string; kind: string; ok: boolean; why: string };
const WHAT = { popunder: "Форматы (зоны)", t12: "Тиры (страны)", both: "Оба фильтра вместе" };
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
              <td className="py-1 pr-2">{WHAT[t.what]}</td>
              <td className="py-1 pr-2 font-mono">{t.what === "both" ? t.param : t.kind}</td>
              <td className={t.ok ? "py-1 text-positive" : "py-1 text-muted"}>{t.ok ? "✓ " : "✗ "}{t.why}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}

export interface BidView { id: string; source: string; sourceSlug: string; tier: number; cpm: number; loadsPerVisit: number; validFrom: string; allSites: boolean }
export function Bids({ bids, sources, siteId, site, source, today }: { bids: BidView[]; sources: { slug: string; title: string }[]; siteId: string; site: string; source: string; today: string }) {
  const [pending, start] = useTransition();
  const toast = useToast();
  const del = (id: string) => start(async () => { const r = await deleteBidAction(id); r.error ? toast(r.error, "error") : toast(r.message ?? "Готово"); });
  return (
    <div className="flex flex-col gap-4" data-testid="buying-bids">
      {bids.length === 0 ? <p className="text-sm text-muted">Ставок нет: расход источника считается как его ревшара от дохода (Настройки → Расходы)</p> : (
        <table className="num w-full text-sm">
          <thead><tr className="border-b border-border text-left text-xs text-muted"><th className="py-1.5 font-medium">Источник</th><th className="font-medium">Тир</th><th className="font-medium">$ за 1000 визитов</th>
            <th className="font-medium">Загрузок на визит</th><th className="font-medium">$ за 1000 загрузок</th><th className="font-medium">С даты</th><th className="font-medium">Сайт</th><th /></tr></thead>
          <tbody>{bids.map((b) => (
            <tr key={b.id} className="border-b border-border/60">
              <td className="py-1.5">{b.source}</td><td>T{b.tier}</td><td>${b.cpm.toFixed(2)}</td><td>{b.loadsPerVisit}</td><td>${(b.cpm / b.loadsPerVisit).toFixed(4)}</td>
              <td className="font-mono text-xs">{b.validFrom}</td><td>{b.allSites ? "все сайты" : site}</td>
              <td className="text-right"><Button size="sm" variant="ghost" disabled={pending} onClick={() => del(b.id)}>Удалить</Button></td>
            </tr>
          ))}</tbody>
        </table>
      )}
      <ActionForm action={saveBidAction} submit="Сохранить ставку" submitSize="sm" className="grid items-end gap-3 sm:grid-cols-3 lg:grid-cols-6 [&>div:last-child]:col-span-full">
        <input type="hidden" name="siteId" value={siteId} />
        <FormField name="sourceSlug" label="Источник">
          <Select name="sourceSlug" key={source} defaultValue={source === "paid" ? "" : source}><option value="">выберите</option>{sources.map((s) => <option key={s.slug} value={s.slug}>{s.title}</option>)}</Select>
        </FormField>
        <FormField name="tier" label="Тир"><Select name="tier" defaultValue="1">{[1, 2, 3, 4, 5].map((t) => <option key={t} value={t}>T{t}</option>)}</Select></FormField>
        <FormField name="cpm" label="Ставка, $ за 1000 визитов"><Input name="cpm" inputMode="decimal" placeholder="1.20" /></FormField>
        <FormField name="loadsPerVisit" label="Загрузок на визит" hint="ADOK считает загрузки страниц; 1 — ставка за 1000 загрузок"><Input name="loadsPerVisit" inputMode="decimal" defaultValue="1" /></FormField>
        <FormField name="validFrom" label="С даты"><Input name="validFrom" type="date" defaultValue={today} /></FormField>
        <label className="flex h-9 items-center gap-2 text-sm"><input type="checkbox" name="allSites" value="1" /> для всех сайтов</label>
      </ActionForm>
    </div>
  );
}
