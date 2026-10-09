"use client";
import { useMemo, useState, useTransition } from "react";
import { ActionForm, FormField } from "@/components/forms/action-form";
import { TableScroll } from "@/components/data/table-scroll";
import { Input, Select } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { fmtDate, fmtInt, fmtMoney } from "@/lib/format";
import { bulkTiersAction, setCountryTierAction } from "@/server/actions/settings";
import { TIERS } from "@/server/domain/tiers";

export interface CountryRow { code: string; name: string; tier: number; loads30: number; revenue30: number }
export interface TierEdit { id: string; code: string; before: string | null; after: string | null; reason: string | null; at: string }

export function TiersTable({ countries, edits }: { countries: CountryRow[]; edits: TierEdit[] }) {
  const [q, setQ] = useState("");
  const [onlyTraffic, setOnlyTraffic] = useState(true);
  const [pending, start] = useTransition();
  const toast = useToast();
  const rows = useMemo(() => countries.filter((c) => (!onlyTraffic || c.loads30 > 0) && (!q || c.code.toLowerCase().includes(q.toLowerCase()) || c.name.toLowerCase().includes(q.toLowerCase()))), [countries, q, onlyTraffic]);
  const counts = TIERS.map((t) => [t, countries.filter((c) => c.tier === t).length] as const);
  const change = (code: string, tier: number) => start(async () => { const r = await setCountryTierAction(code, tier); r.error ? toast(r.error, "error") : toast(r.message ?? "Готово"); });
  return (
    <>
      <p className="text-sm text-muted">Тир страны — как группирует рынок (и ADOK): T1 — США, Западная Европа, Япония… T5 — остальные. Тиры читают фикс-дилы с выбором «T1…T5» и фильтры гео. Правка сохраняется в журнале и не перезаписывается при обновлениях.
        <span className="ml-2 text-faint">{counts.map(([t, n]) => `T${t}: ${n}`).join(" · ")}</span></p>
      <section className="card p-4">
        <ActionForm action={bulkTiersAction} submit="Применить" submitSize="sm" className="grid items-end gap-3 sm:grid-cols-[1fr_200px_auto] [&>div:last-child]:col-span-full">
          <FormField name="bulk" label="Массово" hint="«T2: IT, ES; T3: BR, MX» — коды через запятую после тира"><Input name="bulk" placeholder="T2: IT, ES; T3: BR, MX" className="font-mono" /></FormField>
          <FormField name="reason" label="Причина (необязательно)"><Input name="reason" placeholder="по тарифам ADOK" /></FormField>
        </ActionForm>
      </section>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск: код или название" className="w-full sm:w-64" aria-label="Поиск страны" />
        <label className="flex items-center gap-2 text-muted"><input type="checkbox" checked={onlyTraffic} onChange={(e) => setOnlyTraffic(e.target.checked)} /> только с трафиком за 30 дней</label>
        <span className="text-faint">{rows.length} стран</span>
      </div>
      <section className="card p-0">
        <TableScroll flush><table className="tbl num w-full text-[13px]" data-testid="tiers-table">
          <thead><tr className="border-b border-border text-xs text-muted">{["Код", "Страна", "Тир", "Page loads за 30 дней", "Выручка за 30 дней"].map((h, i) =>
            <th key={h} className={`h-9 px-4 font-medium ${i >= 3 ? "text-right" : "text-left"}`}>{h}</th>)}</tr></thead>
          <tbody>{rows.map((c) => (
            <tr key={c.code} className="h-11 border-b border-border/60 hover:bg-surface-hover" data-code={c.code}>
              <td className="px-4 font-mono">{c.code}</td>
              <td className="px-4">{c.name}</td>
              <td className="px-4"><Select value={String(c.tier)} disabled={pending} onChange={(e) => change(c.code, Number(e.target.value))} className="w-20" aria-label={`Тир ${c.code}`}>
                {TIERS.map((t) => <option key={t} value={t}>T{t}</option>)}</Select></td>
              <td className="px-4 text-right">{c.loads30 ? fmtInt(c.loads30) : <span className="text-faint">—</span>}</td>
              <td className="px-4 text-right">{c.revenue30 ? fmtMoney(c.revenue30) : <span className="text-faint">—</span>}</td>
            </tr>
          ))}</tbody>
        </table></TableScroll>
      </section>
      {edits.length > 0 && (
        <section className="card p-4">
          <h3 className="mb-2 text-sm font-medium">Последние правки</h3>
          <ul className="text-xs text-muted">{edits.map((e) => <li key={e.id}>{fmtDate(e.at)} · {e.code}: T{e.before} → T{e.after}{e.reason ? ` · ${e.reason}` : ""}</li>)}</ul>
        </section>
      )}
    </>
  );
}
