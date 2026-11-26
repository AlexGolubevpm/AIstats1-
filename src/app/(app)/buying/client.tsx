"use client";
// «Окупаемость закупки»: filters kept in the URL (site, tiers, formats), the site → tier → format
// tree, the exact calculation in ADOK, the ADOK filter check and the bids of the sources.
import { Fragment, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, ChevronRight } from "lucide-react";
import { ActionForm, FormField } from "@/components/forms/action-form";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { fmtCpm, fmtMoney } from "@/lib/format";
import { checkBuyingFiltersAction, computeAllSlicesAction, computeSliceAction, deleteBidAction, saveBidAction } from "@/server/actions/buying";

const chip = (on: boolean) => cn("rounded-full border px-2.5 py-0.5 text-xs", on ? "border-accent bg-accent-soft text-accent" : "border-border text-muted hover:bg-surface-hover");

export function BuyingFilters({ sites, site, formats, formatOptions, tiers }: {
  sites: { id: string; domain: string }[]; site: string | null; formats: string[] | null; formatOptions: { id: string; label: string }[]; tiers: number[];
}) {
  const router = useRouter(), path = usePathname(), sp = useSearchParams();
  const go = (k: string, v: string | null) => { const q = new URLSearchParams(sp.toString()); if (v) q.set(k, v); else q.delete(k); router.push(`${path}?${q}`, { scroll: false }); };
  const toggle = <T,>(xs: T[], x: T) => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x]);
  return (
    <div className="card flex flex-col gap-3 p-4 text-sm" data-testid="buying-controls">
      <div className="flex flex-wrap items-center gap-3">
        <Select aria-label="Сайт" value={site ?? ""} onChange={(e) => go("site", e.target.value || null)} className="w-auto" data-testid="buying-site">
          <option value="">Все сайты</option>
          {sites.map((s) => <option key={s.id} value={s.domain}>{s.domain}</option>)}
        </Select>
      </div>
      <div className="flex flex-wrap items-center gap-1" data-testid="buying-tiers">
        <span className="mr-1 w-16 text-xs text-muted">Тиры</span>
        <button type="button" className={chip(tiers.length === 5)} onClick={() => go("tiers", null)}>Все</button>
        {[1, 2, 3, 4, 5].map((t) => (
          <button key={t} type="button" className={chip(tiers.length < 5 && tiers.includes(t))} onClick={() => { const next = toggle(tiers.length === 5 ? [] : tiers, t).sort(); go("tiers", next.length && next.length < 5 ? next.join(",") : null); }}>T{t}</button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1" data-testid="buying-formats">
        <span className="mr-1 w-16 text-xs text-muted">Форматы</span>
        <button type="button" className={chip(!formats)} onClick={() => go("fmt", null)}>Все</button>
        {formatOptions.map((f) => (
          <button key={f.id} type="button" className={chip(Boolean(formats?.includes(f.id)))} onClick={() => go("fmt", toggle(formats ?? [], f.id).join(",") || null)}>{f.label}</button>
        ))}
      </div>
    </div>
  );
}

export interface TreeFormat { format: string; label: string; revenue: number; imps: number; cpm: number | null; exact: boolean }
export interface TreeTier { tier: number; revenue: number; cost: number; cpm: number | null; exact: boolean; formats: TreeFormat[] }
export interface TreeSite { id: string; domain: string; revenue: number; cost: number; cpm: number | null; exact: boolean; computedAt: string | null; notes: string[]; tiers: TreeTier[] }

const Src = ({ exact }: { exact: boolean }) => <span className={exact ? "text-xs text-muted" : "text-xs text-warning"}>{exact ? "ADOK" : "оценка"}</span>;
const Toggle = ({ open }: { open: boolean }) => (open ? <ChevronDown className="size-4 shrink-0 text-muted" /> : <ChevronRight className="size-4 shrink-0 text-muted" />);

/** Site → tier → format: revenue, cost (of the tier's traffic) and CPM. One site is open from the start. */
export function BuyingTree({ rows, total, period }: { rows: TreeSite[]; total: { revenue: number; cost: number; cpm: number | null }; period: { from: string; to: string } }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(rows.length === 1 ? [rows[0].id] : []));
  const [pending, start] = useTransition();
  const toast = useToast();
  const flip = (k: string) => setOpen((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const compute = (siteId: string) => start(async () => { const r = await computeSliceAction({ siteId, ...period }); r.error ? toast(r.error, "error") : toast(r.message ?? "Готово"); });
  const th = "px-3 py-2 text-xs font-medium text-muted", td = "px-3 py-2";
  if (!rows.length) return <p className="text-sm text-muted">Нет данных за период по выбранным сайтам, тирам и форматам</p>;
  return (
    <div className="-mx-5 overflow-x-auto">
      <table className="num w-full text-sm" data-testid="buying-tree">
        <thead><tr className="border-b border-border">
          <th className={cn(th, "pl-5 text-left")}>Сайт / тир / формат</th><th className={cn(th, "text-right")}>Доход</th><th className={cn(th, "text-right")}>Расход</th>
          <th className={cn(th, "text-right")} title="Доход на 1000 показов">CPM</th><th className={cn(th, "text-left")}>Данные</th><th className={cn(th, "pr-5")} />
        </tr></thead>
        <tbody>
          {rows.map((s) => (
            <Fragment key={s.id}>
              <tr className="cursor-pointer border-b border-border/60 font-medium hover:bg-surface-hover" onClick={() => flip(s.id)} data-testid="buying-site-row">
                <td className={cn(td, "pl-5")}><span className="flex items-center gap-1.5"><Toggle open={open.has(s.id)} />{s.domain}</span></td>
                <td className={cn(td, "text-right")}>{fmtMoney(s.revenue)}</td><td className={cn(td, "text-right")}>{fmtMoney(s.cost)}</td><td className={cn(td, "text-right")}>{fmtCpm(s.cpm)}</td>
                <td className={td} title={s.notes.join("; ") || undefined}><Src exact={s.exact} />{s.computedAt && <span className="ml-1 text-xs text-faint">{s.computedAt.slice(0, 10)}</span>}</td>
                <td className={cn(td, "pr-5 text-right")}><Button size="sm" variant="ghost" disabled={pending} onClick={(e) => { e.stopPropagation(); compute(s.id); }}>{s.computedAt ? "Пересчитать" : "Посчитать точно"}</Button></td>
              </tr>
              {open.has(s.id) && s.tiers.map((t) => {
                const k = `${s.id}|${t.tier}`;
                return (
                  <Fragment key={k}>
                    <tr className="cursor-pointer border-b border-border/60 hover:bg-surface-hover" onClick={() => flip(k)} data-testid="buying-tier-row">
                      <td className={cn(td, "pl-10")}><span className="flex items-center gap-1.5"><Toggle open={open.has(k)} />T{t.tier}</span></td>
                      <td className={cn(td, "text-right")}>{fmtMoney(t.revenue)}</td><td className={cn(td, "text-right")}>{fmtMoney(t.cost)}</td><td className={cn(td, "text-right")}>{fmtCpm(t.cpm)}</td>
                      <td className={td}><Src exact={t.exact} /></td><td />
                    </tr>
                    {open.has(k) && t.formats.map((f) => (
                      <tr key={f.format} className="border-b border-border/40 text-[13px] text-muted" data-testid="buying-format-row">
                        <td className={cn(td, "pl-[4.25rem]")}>{f.label}</td>
                        <td className={cn(td, "text-right text-fg")}>{fmtMoney(f.revenue)}</td><td className={cn(td, "text-right text-faint")}>—</td><td className={cn(td, "text-right")}>{fmtCpm(f.cpm)}</td>
                        <td className={td}><Src exact={f.exact} /></td><td />
                      </tr>
                    ))}
                  </Fragment>
                );
              })}
            </Fragment>
          ))}
          <tr className="font-semibold" data-testid="buying-total">
            <td className={cn(td, "pl-5")}>Итого</td><td className={cn(td, "text-right")}>{fmtMoney(total.revenue)}</td><td className={cn(td, "text-right")}>{fmtMoney(total.cost)}</td>
            <td className={cn(td, "text-right")}>{fmtCpm(total.cpm)}</td><td /><td />
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export function ComputeAll({ period, done, of }: { period: { from: string; to: string }; done: number; of: number }) {
  const [pending, start] = useTransition();
  const toast = useToast();
  const run = () => start(async () => { const r = await computeAllSlicesAction(period); r.error ? toast(r.error, "error") : toast(r.message ?? "Готово"); });
  return (
    <span className="flex items-center gap-3 text-xs text-muted">
      <span data-testid="buying-computed">точно посчитано {done} из {of} сайтов</span>
      <Button size="sm" disabled={pending} onClick={run} data-testid="buying-compute-all">{pending ? "Ставим в очередь…" : "Посчитать все сайты"}</Button>
    </span>
  );
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

export interface BidView { id: string; source: string; sourceSlug: string; tier: number; cpm: number; loadsPerVisit: number; validFrom: string; site: string | null }
export function Bids({ bids, sources, sites, site, today }: { bids: BidView[]; sources: { slug: string; title: string }[]; sites: { id: string; domain: string }[]; site: string | null; today: string }) {
  const [pending, start] = useTransition();
  const toast = useToast();
  const del = (id: string) => start(async () => { const r = await deleteBidAction(id); r.error ? toast(r.error, "error") : toast(r.message ?? "Готово"); });
  return (
    <div className="flex flex-col gap-4" data-testid="buying-bids">
      {bids.length === 0 ? <p className="text-sm text-muted">Ставок нет: расход источника считается как его ревшара от дохода (Настройки → Расходы)</p> : (
        <table className="num w-full text-sm">
          <thead><tr className="border-b border-border text-left text-xs text-muted"><th className="py-1.5 font-medium">Источник</th><th className="font-medium">Тир</th><th className="font-medium">$ за 1000 визитов</th>
            <th className="font-medium">Загрузок на визит</th><th className="font-medium">С даты</th><th className="font-medium">Сайт</th><th /></tr></thead>
          <tbody>{bids.map((b) => (
            <tr key={b.id} className="border-b border-border/60">
              <td className="py-1.5">{b.source}</td><td>T{b.tier}</td><td>${b.cpm.toFixed(2)}</td><td>{b.loadsPerVisit}</td>
              <td className="font-mono text-xs">{b.validFrom}</td><td>{b.site ?? "все сайты"}</td>
              <td className="text-right"><Button size="sm" variant="ghost" disabled={pending} onClick={() => del(b.id)}>Удалить</Button></td>
            </tr>
          ))}</tbody>
        </table>
      )}
      <ActionForm action={saveBidAction} submit="Сохранить ставку" submitSize="sm" className="grid items-end gap-3 sm:grid-cols-3 lg:grid-cols-6 [&>div:last-child]:col-span-full">
        <FormField name="sourceSlug" label="Источник">
          <Select name="sourceSlug" defaultValue=""><option value="">выберите</option>{sources.map((s) => <option key={s.slug} value={s.slug}>{s.title}</option>)}</Select>
        </FormField>
        <FormField name="tier" label="Тир"><Select name="tier" defaultValue="1">{[1, 2, 3, 4, 5].map((t) => <option key={t} value={t}>T{t}</option>)}</Select></FormField>
        <FormField name="cpm" label="Ставка, $ за 1000 визитов"><Input name="cpm" inputMode="decimal" placeholder="1.20" /></FormField>
        <FormField name="loadsPerVisit" label="Загрузок на визит" hint="ADOK считает загрузки страниц; 1 — ставка за 1000 загрузок"><Input name="loadsPerVisit" inputMode="decimal" defaultValue="1" /></FormField>
        <FormField name="validFrom" label="С даты"><Input name="validFrom" type="date" defaultValue={today} /></FormField>
        <FormField name="siteId" label="Сайт">
          <Select name="siteId" key={site ?? ""} defaultValue={sites.find((s) => s.domain === site)?.id ?? ""}><option value="">все сайты</option>{sites.map((s) => <option key={s.id} value={s.id}>{s.domain}</option>)}</Select>
        </FormField>
      </ActionForm>
    </div>
  );
}
