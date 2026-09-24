"use client";
import { useState, useTransition } from "react";
import { ActionForm, FormField } from "@/components/forms/action-form";
import { StatusBadge } from "@/components/data/misc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { useToast } from "@/components/ui/toast";
import { fmtAgo, fmtDate } from "@/lib/format";
import { asgSitesAction, bulkSitesAction, checkSiteAction, importAsgSitesAction, saveSiteAction } from "@/server/actions/settings";

export interface SiteRow { id: string; domain: string; title: string; adsgSiteId: number | null; metrikaId: string | null; status: string; launchedAt: string | null;
  bundles: { id: string; title: string; color: string }[]; lastAsg: string | null; lastMetrika: string | null }

function SiteForm({ site, onDone }: { site?: SiteRow; onDone: () => void }) {
  return (
    <ActionForm action={saveSiteAction} submit={site ? "Сохранить" : "Добавить сайт"} onDone={onDone} cancel={onDone}>
      {site && <input type="hidden" name="id" value={site.id} />}
      <FormField name="domain" label="Домен" hint="Приводится к нижнему регистру без www."><Input name="domain" defaultValue={site?.domain} required className="font-mono" /></FormField>
      <FormField name="title" label="Название"><Input name="title" defaultValue={site?.title} /></FormField>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField name="adsgSiteId" label="AdSpyglass ID"><Input name="adsgSiteId" inputMode="numeric" defaultValue={site?.adsgSiteId ?? ""} className="num" /></FormField>
        <FormField name="metrikaId" label="Счётчик Метрики"><Input name="metrikaId" inputMode="numeric" defaultValue={site?.metrikaId ?? ""} className="num" /></FormField>
        <FormField name="status" label="Статус">
          <Select name="status" defaultValue={site?.status ?? "ACTIVE"}><option value="ACTIVE">Активен</option><option value="PAUSED">Пауза — не тянется</option><option value="ARCHIVED">Архив — скрыт</option></Select>
        </FormField>
        <FormField name="launchedAt" label="Дата запуска"><Input type="date" name="launchedAt" defaultValue={site?.launchedAt ?? ""} /></FormField>
      </div>
      <p className="text-xs text-muted">Обязателен хотя бы один из двух ID.</p>
    </ActionForm>
  );
}

export function SitesManager({ sites, bundles }: { sites: SiteRow[]; bundles: { id: string; title: string }[] }) {
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [edit, setEdit] = useState<SiteRow | "new" | null>(null);
  const [q, setQ] = useState("");
  const [missing, setMissing] = useState<{ adsgSiteId: number; domain: string }[] | null>(null);
  const [pending, start] = useTransition();
  const toast = useToast();
  const run = (fn: () => Promise<{ ok?: boolean; error?: string; message?: string; data?: Record<string, unknown> }>, after?: (d?: Record<string, unknown>) => void) =>
    start(async () => { const r = await fn(); if (r.error) toast(r.error, "error"); else { if (r.message) toast(r.message); after?.(r.data); } });
  const visible = sites.filter((s) => !q || s.domain.includes(q.toLowerCase()) || s.title.toLowerCase().includes(q.toLowerCase()));
  const ids = [...sel];

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Input placeholder="Поиск" value={q} onChange={(e) => setQ(e.target.value)} className="w-56" />
        <span className="flex-1" />
        <Button size="sm" disabled={pending} onClick={() => run(asgSitesAction, (d) => setMissing((d?.missing as never) ?? []))}>Подтянуть сайты из AdSpyglass</Button>
        <Button size="sm" variant="primary" onClick={() => setEdit("new")}>Добавить сайт</Button>
      </div>
      {sel.size > 0 && (
        <div className="card flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
          <span className="font-medium">Выбрано: {sel.size}</span>
          <Select className="h-8 w-44" defaultValue="" onChange={(e) => { const [op, arg] = e.target.value.split(":"); if (op) run(() => bulkSitesAction(ids, op, arg), () => setSel(new Set())); e.target.value = ""; }}>
            <option value="">Действие…</option>
            <optgroup label="Статус"><option value="status:ACTIVE">Активен</option><option value="status:PAUSED">Пауза</option><option value="status:ARCHIVED">Архив</option></optgroup>
            <optgroup label="Добавить в бандл">{bundles.map((b) => <option key={b.id} value={`add:${b.id}`}>{b.title}</option>)}</optgroup>
            <optgroup label="Убрать из бандла">{bundles.map((b) => <option key={b.id} value={`remove:${b.id}`}>{b.title}</option>)}</optgroup>
          </Select>
          <Button size="sm" variant="ghost" onClick={() => setSel(new Set())}>Снять выделение</Button>
        </div>
      )}
      <section className="card overflow-x-auto p-0">
        <table className="num w-full text-[13px]">
          <thead><tr className="border-b border-border text-xs text-muted">
            <th className="w-10 pl-4"><input type="checkbox" aria-label="Выбрать все" checked={visible.length > 0 && visible.every((s) => sel.has(s.id))}
              onChange={(e) => setSel(e.target.checked ? new Set(visible.map((s) => s.id)) : new Set())} /></th>
            {["Домен", "AdSpyglass ID", "Метрика", "Бандлы", "Статус", "Запуск", "Последние данные", ""].map((h, i) => <th key={i} className="h-9 px-3 text-left font-medium">{h}</th>)}
          </tr></thead>
          <tbody>{visible.map((s) => (
            <tr key={s.id} className="h-11 border-b border-border/60 hover:bg-surface-hover">
              <td className="pl-4"><input type="checkbox" aria-label={s.domain} checked={sel.has(s.id)} onChange={(e) => { const n = new Set(sel); e.target.checked ? n.add(s.id) : n.delete(s.id); setSel(n); }} /></td>
              <td className="px-3"><button className="font-mono text-xs hover:text-accent" onClick={() => setEdit(s)}>{s.domain}</button>
                {s.title !== s.domain && <div className="text-[11px] text-muted">{s.title}</div>}</td>
              <td className="px-3">{s.adsgSiteId ?? <span className="text-faint">—</span>}</td>
              <td className="px-3">{s.metrikaId ?? <span className="text-faint">—</span>}</td>
              <td className="px-3"><span className="flex flex-wrap gap-1">{s.bundles.map((b) => <Badge key={b.id}><span className="size-1.5 rounded-full" style={{ background: b.color }} />{b.title}</Badge>)}</span></td>
              <td className="px-3"><StatusBadge status={s.status} /></td>
              <td className="px-3 text-muted">{fmtDate(s.launchedAt)}</td>
              <td className="px-3 text-[11px] text-muted">ASG {s.lastAsg ? fmtAgo(s.lastAsg) : "—"}<br />Метрика {s.lastMetrika ? fmtAgo(s.lastMetrika) : "—"}</td>
              <td className="pr-4 text-right"><Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => checkSiteAction(s.id))}>Проверить</Button></td>
            </tr>
          ))}
          {visible.length === 0 && <tr><td colSpan={9} className="py-10 text-center text-sm text-muted">Сайтов нет — добавьте первый или подтяните из AdSpyglass</td></tr>}
          </tbody>
        </table>
      </section>
      <Sheet open={edit != null} onOpenChange={(v) => !v && setEdit(null)} title={edit === "new" ? "Новый сайт" : "Сайт"}>
        {edit != null && <SiteForm key={edit === "new" ? "new" : edit.id} site={edit === "new" ? undefined : edit} onDone={() => setEdit(null)} />}
      </Sheet>
      <Sheet open={missing != null} onOpenChange={(v) => !v && setMissing(null)} title="Сайты из AdSpyglass" description="Домены, которых ещё нет в TubeStat. ID уже заполнен.">
        {missing?.length ? (
          <div className="flex flex-col gap-3">
            <ul className="divide-y divide-border rounded-lg border border-border text-sm">{missing.map((m) => (
              <li key={m.adsgSiteId} className="flex justify-between px-3 py-2"><span className="font-mono text-xs">{m.domain}</span><span className="num text-muted">{m.adsgSiteId}</span></li>
            ))}</ul>
            <Button variant="primary" disabled={pending} onClick={() => run(() => importAsgSitesAction(missing), () => setMissing(null))}>Добавить все ({missing.length})</Button>
          </div>
        ) : <p className="text-sm text-muted">Новых сайтов нет.</p>}
      </Sheet>
    </>
  );
}
