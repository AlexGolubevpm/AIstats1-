"use client";
import { useState, useTransition } from "react";
import { ActionForm, FormField } from "@/components/forms/action-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Confirm, Sheet } from "@/components/ui/sheet";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { fmtMoney } from "@/lib/format";
import { deleteBundleAction, saveBundleAction } from "@/server/actions/settings";

export interface BundleRow { id: string; slug: string; title: string; color: string; siteIds: string[]; revenue30: number }
export interface SiteOpt { id: string; domain: string; bundles: string[] }

function BundleForm({ b, sites, used, palette, onDone }: { b?: BundleRow; sites: SiteOpt[]; used: string[]; palette: string[]; onDone: () => void }) {
  const [members, setMembers] = useState<Set<string>>(new Set(b?.siteIds ?? []));
  const [color, setColor] = useState(b?.color ?? palette.find((c) => !used.includes(c)) ?? palette[0]);
  const [slug, setSlug] = useState(b?.slug ?? "");
  const [q, setQ] = useState("");
  const match = (s: SiteOpt) => !q || s.domain.includes(q.toLowerCase());
  const col = (inside: boolean) => sites.filter((s) => members.has(s.id) === inside && match(s));
  const toggle = (id: string) => { const n = new Set(members); n.has(id) ? n.delete(id) : n.add(id); setMembers(n); };
  return (
    <ActionForm action={saveBundleAction} submit={b ? "Сохранить" : "Создать бандл"} onDone={onDone} cancel={onDone}>
      {b && <input type="hidden" name="id" value={b.id} />}
      <input type="hidden" name="members" value="1" />
      {[...members].map((id) => <input key={id} type="hidden" name="siteIds" value={id} />)}
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField name="title" label="Название"><Input name="title" defaultValue={b?.title} required /></FormField>
        <FormField name="slug" label="Слаг" hint={b && slug !== b.slug ? <span className="text-warning">Старые ссылки /bundles/{b.slug} перестанут работать</span> : "Латиница, для URL"}>
          <Input name="slug" value={slug} onChange={(e) => setSlug(e.target.value)} required className="font-mono" />
        </FormField>
      </div>
      <FormField name="color" label="Цвет">
        <input type="hidden" name="color" value={color} />
        <div className="flex flex-wrap gap-2">{palette.map((c) => (
          <button type="button" key={c} onClick={() => setColor(c)} title={used.includes(c) && c !== b?.color ? "уже занят" : c}
            className={cn("relative size-7 rounded-full border-2", color === c ? "border-text" : "border-transparent")} style={{ background: c }}>
            {used.includes(c) && c !== b?.color && <span className="absolute inset-0 grid place-items-center text-[10px] text-white">●</span>}
          </button>
        ))}</div>
      </FormField>
      <Input placeholder="Поиск сайта" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="grid gap-3 sm:grid-cols-2">
        {([true, false] as const).map((inside) => (
          <div key={String(inside)} className="rounded-lg border border-border">
            <div className="border-b border-border px-3 py-2 text-xs font-medium text-muted">{inside ? `В бандле · ${members.size}` : "Остальные"}</div>
            <ul className="max-h-72 overflow-y-auto p-1">{col(inside).map((s) => (
              <li key={s.id}><label className="flex cursor-pointer items-start gap-2 rounded px-2 py-1 hover:bg-surface-hover">
                <input type="checkbox" checked={inside} onChange={() => toggle(s.id)} className="mt-0.5" />
                <span className="min-w-0"><span className="block font-mono text-xs">{s.domain}</span>
                  {s.bundles.length > 0 && <span className="block text-[11px] text-faint">{s.bundles.join(", ")}</span>}</span>
              </label></li>
            ))}</ul>
          </div>
        ))}
      </div>
    </ActionForm>
  );
}

export function BundlesManager({ bundles, sites, palette }: { bundles: BundleRow[]; sites: SiteOpt[]; palette: string[] }) {
  const [edit, setEdit] = useState<BundleRow | "new" | null>(null);
  const [del, setDel] = useState<BundleRow | null>(null);
  const [, start] = useTransition();
  const toast = useToast();
  const used = bundles.map((b) => b.color.toUpperCase());
  return (
    <>
      <div className="flex justify-end"><Button size="sm" variant="primary" onClick={() => setEdit("new")}>Создать бандл</Button></div>
      <section className="card p-0">
        <table className="num w-full text-[13px]">
          <thead><tr className="border-b border-border text-xs text-muted">{["Название", "Слаг", "Сайтов", "Выручка за 30 дней", ""].map((h, i) =>
            <th key={i} className={cn("h-9 px-4 font-medium", i >= 2 && i < 4 ? "text-right" : "text-left")}>{h}</th>)}</tr></thead>
          <tbody>{bundles.map((b) => (
            <tr key={b.id} className="h-11 border-b border-border/60 hover:bg-surface-hover">
              <td className="px-4"><button onClick={() => setEdit(b)} className="flex items-center gap-2 hover:text-accent"><span className="size-2.5 rounded-full" style={{ background: b.color }} />{b.title}</button></td>
              <td className="px-4 font-mono text-xs text-muted">{b.slug}</td>
              <td className="px-4 text-right">{b.siteIds.length}</td>
              <td className="px-4 text-right">{fmtMoney(b.revenue30)}</td>
              <td className="px-4 text-right"><Button size="sm" variant="ghost" onClick={() => setDel(b)}>Удалить</Button></td>
            </tr>
          ))}
          {bundles.length === 0 && <tr><td colSpan={5} className="py-10 text-center text-sm text-muted">Бандлов нет</td></tr>}</tbody>
        </table>
      </section>
      <Sheet open={edit != null} onOpenChange={(v) => !v && setEdit(null)} title={edit === "new" ? "Новый бандл" : "Бандл"} width="max-w-2xl">
        {edit != null && <BundleForm key={edit === "new" ? "new" : edit.id} b={edit === "new" ? undefined : edit} sites={sites} used={used} palette={palette} onDone={() => setEdit(null)} />}
      </Sheet>
      <Confirm open={del != null} onOpenChange={(v) => !v && setDel(null)} title={`Удалить бандл «${del?.title}»?`} destructive confirmLabel="Удалить"
        body="Сайты и их данные останутся, пропадёт только группировка."
        onConfirm={() => del && start(async () => { const r = await deleteBundleAction(del.id); r.error ? toast(r.error, "error") : toast(r.message ?? "Удалено"); })} />
    </>
  );
}
