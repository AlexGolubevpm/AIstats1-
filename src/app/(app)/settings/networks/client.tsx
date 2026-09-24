"use client";
import { useState } from "react";
import { ActionForm, FormField } from "@/components/forms/action-form";
import { Badge } from "@/components/ui/badge";
import { Input, Select } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { fmtMoney } from "@/lib/format";
import { saveNetworkAction } from "@/server/actions/settings";

export interface NetRow { id: string; slug: string; title: string; color: string; kind: string; showInLegend: boolean; isSystem: boolean; revenue30: number }

export function NetworksTable({ nets, max }: { nets: NetRow[]; max: number }) {
  const [edit, setEdit] = useState<NetRow | null>(null);
  const shown = nets.filter((n) => n.showInLegend && !n.isSystem).length;
  return (
    <>
      <p className="text-sm text-muted">Цветных сеток: {shown} из {max}. Остальные схлопываются в «Прочее» на всех графиках.</p>
      <section className="card p-0">
        <table className="num w-full text-[13px]">
          <thead><tr className="border-b border-border text-xs text-muted">{["Сетка", "Слаг", "Тип", "В легенде", "Выручка за 30 дней"].map((h, i) =>
            <th key={h} className={`h-9 px-4 font-medium ${i === 4 ? "text-right" : "text-left"}`}>{h}</th>)}</tr></thead>
          <tbody>{nets.map((n) => (
            <tr key={n.id} className="h-11 border-b border-border/60 hover:bg-surface-hover">
              <td className="px-4"><button onClick={() => setEdit(n)} className="flex items-center gap-2 hover:text-accent">
                <span className="size-2.5 rounded-full" style={{ background: n.showInLegend ? n.color : "#94A3B8" }} />{n.title}{n.isSystem && <Badge>системная</Badge>}</button></td>
              <td className="px-4 font-mono text-xs text-muted">{n.slug}</td>
              <td className="px-4">{n.kind}</td>
              <td className="px-4">{n.showInLegend ? "да" : <span className="text-muted">Прочее</span>}</td>
              <td className="px-4 text-right">{fmtMoney(n.revenue30)}</td>
            </tr>
          ))}</tbody>
        </table>
      </section>
      <Sheet open={edit != null} onOpenChange={(v) => !v && setEdit(null)} title={edit?.title ?? ""} description={edit?.slug === "own_deals" ? "own_deals — системная, цвет всегда зелёный" : undefined}>
        {edit && (
          <ActionForm key={edit.id} action={saveNetworkAction} submit="Сохранить" onDone={() => setEdit(null)} cancel={() => setEdit(null)}>
            <input type="hidden" name="id" value={edit.id} />
            <FormField name="title" label="Название"><Input name="title" defaultValue={edit.title} /></FormField>
            <FormField name="color" label="Цвет"><Input type="color" name="color" defaultValue={edit.color} disabled={edit.slug === "own_deals"} className="h-10 w-20 p-1" /></FormField>
            {edit.slug === "own_deals" && <input type="hidden" name="color" value={edit.color} />}
            <FormField name="kind" label="Тип"><Select name="kind" defaultValue={edit.kind}><option>MEDIATED</option><option>DIRECT</option><option>MARKETPLACE</option></Select></FormField>
            <FormField name="showInLegend" label="Показывать в легенде">
              <Select name="showInLegend" defaultValue={edit.showInLegend ? "1" : "0"}><option value="1">Да, своим цветом</option><option value="0">Нет, в «Прочее»</option></Select>
            </FormField>
          </ActionForm>
        )}
      </Sheet>
    </>
  );
}
