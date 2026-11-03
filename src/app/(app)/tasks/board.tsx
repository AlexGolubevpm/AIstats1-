"use client";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { ActionForm, FormField } from "@/components/forms/action-form";
import { FORMAT_LABEL } from "@/components/pages/columns";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { createTaskAction, deleteTaskAction, moveTaskAction, updateTaskAction } from "@/server/actions/tasks";
import {
  initials, TASK_IMPACT_LABEL, TASK_IMPACT_TONE, TASK_IMPACTS, TASK_PRIORITIES, TASK_PRIORITY_LABEL, TASK_STATUS_LABEL, TASK_STATUSES, type TaskStatus,
} from "@/server/domain/tasks";
import type { TaskCard } from "@/server/queries/tasks";

export interface TaskOptions { team: { id: string; name: string }[]; sites: { id: string; domain: string }[]; advertisers: { id: string; name: string }[] }
export interface HistoryLine { id: string; at: string; field: string; before: string | null; after: string | null }

const usd = (v: number) => `$${v.toLocaleString("ru-RU", { maximumFractionDigits: 0 })}`;
const ru = (s: string) => `${s.slice(8, 10)}.${s.slice(5, 7)}`;
const FIELD: Record<string, string> = { created: "создана", status: "статус", title: "название", description: "описание", assignee: "исполнитель", impact: "на что влияем",
  impactMonth: "эффект", priority: "приоритет", advertiserId: "рекламодатель", format: "формат", siteId: "сайт", hypothesisId: "гипотеза", startDate: "начало", dueDate: "срок" };

/** Kanban like a Notion board: drag cards between and inside columns; a click opens the card's panel (`?task=`). */
export function TaskBoard({ board, options, open, history, today }: {
  board: Record<TaskStatus, TaskCard[]>; options: TaskOptions; open: TaskCard | null; history: HistoryLine[]; today: string;
}) {
  const [cols, setCols] = useState(board);
  useEffect(() => setCols(board), [board]);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<{ status: TaskStatus; index: number } | null>(null);
  const [, start] = useTransition();
  const router = useRouter(), path = usePathname(), sp = useSearchParams();
  const toast = useToast();
  const link = (task: string | null) => { const q = new URLSearchParams(sp.toString()); if (task) q.set("task", task); else q.delete("task"); return `${path}${q.size ? `?${q}` : ""}`; };

  function drop(status: TaskStatus, index: number) {
    if (!drag) return;
    const all = TASK_STATUSES.flatMap((s) => cols[s]);
    const card = all.find((c) => c.id === drag);
    if (!card) return;
    const next = { ...cols } as Record<TaskStatus, TaskCard[]>;
    for (const s of TASK_STATUSES) next[s] = next[s].filter((c) => c.id !== drag);
    const target = [...next[status]];
    const at = Math.min(index, target.length);
    target.splice(at, 0, { ...card, status });
    next[status] = target;
    setCols(next); setDrag(null); setOver(null);
    const before = target[at - 1]?.id ?? null, after = target[at + 1]?.id ?? null;
    start(async () => {
      const r = await moveTaskAction(card.id, status, before, after);
      if (r.error) { toast(r.error, "error"); setCols(board); } else router.refresh();
    });
  }

  return (
    <>
      <div className="-mx-4 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0" data-testid="task-board">
        <div className="grid min-w-[1100px] grid-cols-5 gap-3">
          {TASK_STATUSES.map((s) => {
            const list = cols[s];
            const sum = list.reduce((a, c) => a + (c.impactMonth ?? 0), 0);
            return (
              <section key={s} data-column={s} className="flex min-h-40 flex-col rounded-xl bg-surface-2/60 p-2"
                onDragOver={(e) => { e.preventDefault(); if (!over || over.status !== s) setOver({ status: s, index: list.length }); }}
                onDrop={(e) => { e.preventDefault(); drop(s, over?.status === s ? over.index : list.length); }}>
                <header className="mb-2 flex items-center justify-between px-1 text-sm">
                  <span className="font-medium">{TASK_STATUS_LABEL[s]} <span className="text-faint">{list.length}</span></span>
                  {sum > 0 && <span className="num text-xs text-muted">{usd(sum)}/мес</span>}
                </header>
                <ul className="flex flex-col gap-2">
                  {list.map((c, i) => (
                    <li key={c.id} draggable onDragStart={(e) => { setDrag(c.id); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", c.id); }}
                      onDragEnd={() => { setDrag(null); setOver(null); }}
                      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setOver({ status: s, index: e.clientY < r.top + r.height / 2 ? i : i + 1 }); }}
                      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); drop(s, over?.status === s ? over.index : i); }}
                      className={cn("relative", drag === c.id && "opacity-40")} data-task={c.id}>
                      {over?.status === s && over.index === i && drag && drag !== c.id && <div className="absolute -top-1.5 right-0 left-0 h-0.5 rounded bg-accent" />}
                      <Card c={c} href={link(c.id)} today={today} />
                      {over?.status === s && over.index === i + 1 && i === list.length - 1 && drag && drag !== c.id && <div className="absolute right-0 -bottom-1.5 left-0 h-0.5 rounded bg-accent" />}
                    </li>
                  ))}
                </ul>
                <QuickAdd status={s} />
              </section>
            );
          })}
        </div>
      </div>
      <Sheet open={Boolean(open)} onOpenChange={(v) => { if (!v) router.push(link(null), { scroll: false }); }} title={open?.title ?? ""} width="max-w-2xl"
        description={open ? `${TASK_STATUS_LABEL[open.status]}${open.hypothesis ? ` · из гипотезы «${open.hypothesis.title}»` : ""}` : undefined}>
        {open && <TaskPanel key={open.id} t={open} options={options} history={history} onDone={() => router.push(link(null), { scroll: false })} />}
      </Sheet>
    </>
  );
}

function Card({ c, href, today }: { c: TaskCard; href: string; today: string }) {
  const late = c.dueDate && c.dueDate < today && c.status !== "DONE";
  return (
    <Link href={href} scroll={false} className="block rounded-lg border border-border bg-surface p-2.5 shadow-sm transition-colors hover:border-border-strong">
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 text-sm font-medium leading-snug">{c.priority === "HIGH" && <span className="mr-1 text-negative" title="высокий приоритет">!</span>}{c.title}</span>
        {c.assignee && <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent-soft text-[10px] font-semibold text-accent" title={c.assignee}>{initials(c.assignee)}</span>}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[11px]">
        {c.impact && <span className={cn("rounded px-1.5 py-0.5", TASK_IMPACT_TONE[c.impact])}>{TASK_IMPACT_LABEL[c.impact]}</span>}
        {c.site && <span className="rounded bg-surface-2 px-1.5 py-0.5 text-muted">{c.site.domain}</span>}
        {c.format && <span className="rounded bg-surface-2 px-1.5 py-0.5 text-muted">{FORMAT_LABEL[c.format] ?? c.format}</span>}
        {c.advertiser && <span className="rounded bg-surface-2 px-1.5 py-0.5 text-muted">{c.advertiser.name}</span>}
        {c.hypothesis && <span className="rounded bg-surface-2 px-1.5 py-0.5 text-muted" title={c.hypothesis.title}>гипотеза</span>}
      </div>
      {(c.dueDate || c.startDate || c.impactMonth) && (
        <div className="num mt-1.5 flex items-center justify-between text-[11px] text-muted">
          <span className={cn(late && "font-medium text-negative")}>{c.startDate && c.dueDate && c.startDate !== c.dueDate ? `${ru(c.startDate)}–${ru(c.dueDate)}` : c.dueDate ? `до ${ru(c.dueDate)}` : c.startDate ? `с ${ru(c.startDate)}` : ""}</span>
          {c.impactMonth ? <span>{usd(c.impactMonth)}/мес</span> : null}
        </div>
      )}
    </Link>
  );
}

function QuickAdd({ status }: { status: TaskStatus }) {
  const [open, setOpen] = useState(false);
  if (!open) return <button type="button" onClick={() => setOpen(true)} className="mt-2 rounded-md px-2 py-1.5 text-left text-sm text-muted hover:bg-surface-hover" data-quick-add={status}>+ Задача</button>;
  return (
    <div className="mt-2">
      <ActionForm action={createTaskAction} submit="Добавить" submitSize="sm" onDone={() => setOpen(false)} cancel={() => setOpen(false)} className="flex flex-col gap-2 [&>div:last-child]:pt-0">
        <input type="hidden" name="status" value={status} />
        <Input name="title" autoFocus placeholder="Что сделать" required />
      </ActionForm>
    </div>
  );
}

/** The card's panel: every field like a Notion page, the history underneath. */
function TaskPanel({ t, options, history, onDone }: { t: TaskCard; options: TaskOptions; history: HistoryLine[]; onDone: () => void }) {
  const show = (field: string, v: string | null) => v == null ? "—" : field === "status" ? TASK_STATUS_LABEL[v as TaskStatus] ?? v : field === "impact" ? TASK_IMPACT_LABEL[v as keyof typeof TASK_IMPACT_LABEL] ?? v
    : field === "siteId" ? options.sites.find((s) => s.id === v)?.domain ?? v : field === "advertiserId" ? options.advertisers.find((a) => a.id === v)?.name ?? v
    : field === "format" ? FORMAT_LABEL[v] ?? v : field === "priority" ? TASK_PRIORITY_LABEL[v as keyof typeof TASK_PRIORITY_LABEL] ?? v : v;
  return (
    <div className="space-y-6" data-testid="task-panel">
      <ActionForm action={updateTaskAction} submit="Сохранить">
        <input type="hidden" name="id" value={t.id} />
        {t.hypothesis && <input type="hidden" name="hypothesisId" value={t.hypothesis.id} />}
        <FormField name="title" label="Название"><Input name="title" defaultValue={t.title} required /></FormField>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField name="status" label="Колонка"><Select name="status" defaultValue={t.status}>{TASK_STATUSES.map((s) => <option key={s} value={s}>{TASK_STATUS_LABEL[s]}</option>)}</Select></FormField>
          <FormField name="assignee" label="Исполнитель" hint="Новое имя попадёт в список команды">
            <Input name="assignee" list="team" defaultValue={t.assignee ?? ""} placeholder="—" autoComplete="off" />
          </FormField>
          <datalist id="team">{options.team.map((m) => <option key={m.id} value={m.name} />)}</datalist>
          <FormField name="impact" label="На что влияем">
            <Select name="impact" defaultValue={t.impact ?? ""}><option value="">—</option>{TASK_IMPACTS.map((k) => <option key={k} value={k}>{TASK_IMPACT_LABEL[k]}</option>)}</Select>
          </FormField>
          <FormField name="impactMonth" label="Эффект, $/мес"><Input name="impactMonth" inputMode="decimal" defaultValue={t.impactMonth ?? ""} className="num" placeholder="0" /></FormField>
          <FormField name="siteId" label="Сайт"><Select name="siteId" defaultValue={t.site?.id ?? ""}><option value="">—</option>{options.sites.map((s) => <option key={s.id} value={s.id}>{s.domain}</option>)}</Select></FormField>
          <FormField name="format" label="Формат"><Select name="format" defaultValue={t.format ?? ""}><option value="">—</option>{Object.keys(FORMAT_LABEL).map((f) => <option key={f} value={f}>{FORMAT_LABEL[f]}</option>)}</Select></FormField>
          <FormField name="advertiser" label="Рекламодатель"><Input name="advertiser" list="advertisers-t" defaultValue={t.advertiser?.name ?? ""} placeholder="—" autoComplete="off" /></FormField>
          <datalist id="advertisers-t">{options.advertisers.map((a) => <option key={a.id} value={a.name} />)}</datalist>
          <FormField name="priority" label="Приоритет"><Select name="priority" defaultValue={t.priority}>{TASK_PRIORITIES.map((p) => <option key={p} value={p}>{TASK_PRIORITY_LABEL[p]}</option>)}</Select></FormField>
          <FormField name="startDate" label="Начало"><Input type="date" name="startDate" defaultValue={t.startDate ?? ""} /></FormField>
          <FormField name="dueDate" label="Срок"><Input type="date" name="dueDate" defaultValue={t.dueDate ?? ""} /></FormField>
        </div>
        <FormField name="description" label="Описание"><Textarea name="description" rows={5} defaultValue={t.description ?? ""} placeholder="Что сделать, как проверить, ссылки" /></FormField>
      </ActionForm>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="flex flex-wrap gap-3">
          {t.hypothesis && <Link href={`/hypotheses/${t.hypothesis.id}`} className="text-accent hover:underline">Гипотеза →</Link>}
          {t.site && <Link href={`/sites/${t.site.domain}`} className="text-accent hover:underline">Сайт →</Link>}
        </span>
        <ActionForm action={deleteTaskAction} submit="Удалить задачу" className="inline" submitVariant="ghost" submitSize="sm" onDone={onDone}>
          <input type="hidden" name="id" value={t.id} />
        </ActionForm>
      </div>
      <div>
        <h3 className="mb-1 text-sm font-medium">История</h3>
        <ul className="divide-y divide-border text-[13px]" data-testid="task-history">
          {history.map((h) => (
            <li key={h.id} className="flex flex-wrap gap-x-3 py-1.5">
              <span className="w-28 shrink-0 text-muted">{ru(h.at.slice(0, 10))} {h.at.slice(11, 16)}</span>
              <span className="font-medium">{FIELD[h.field] ?? h.field}</span>
              {h.before != null && h.field !== "created" && <span className="text-muted line-through">{show(h.field, h.before)}</span>}
              {h.after != null && <span>{h.field === "created" ? "" : show(h.field, h.after)}</span>}
            </li>
          ))}
        </ul>
      </div>
      <Button type="button" variant="ghost" size="sm" onClick={onDone}>Закрыть</Button>
    </div>
  );
}
