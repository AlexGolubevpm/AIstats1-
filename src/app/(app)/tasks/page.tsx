import Link from "next/link";
import { PageHeader } from "@/components/layout/page-header";
import { FORMAT_LABEL } from "@/components/pages/columns";
import { Section } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import { db } from "@/server/db";
import { periodRange, TASK_IMPACT_LABEL, TASK_IMPACTS, TASK_PERIOD_LABEL, TASK_PERIODS, TASK_STATUS_LABEL, TASK_STATUSES, type TaskStatus } from "@/server/domain/tasks";
import { taskBoard, taskHistory, taskOptions, type TaskCard } from "@/server/queries/tasks";
import { TaskBoard } from "./board";
import { FilterSelect, MineChip, PeriodMonth } from "./filters";

const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
const monthLabel = (m: string) => `${MONTHS[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}`;

/** /tasks — the team's board (ADR 0021): columns by status, filters and periods in the URL, `?task=` opens a card. */
export default async function Tasks({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const today = new Date().toISOString().slice(0, 10);
  const period = sp.period && (TASK_PERIODS.includes(sp.period as never) || /^\d{4}-(0[1-9]|1[0-2])$/.test(sp.period)) ? sp.period : "all";
  const filter = { assignee: sp.assignee ?? null, siteId: sp.site ?? null, format: sp.format ?? null, advertiserId: sp.advertiser ?? null, impact: sp.impact ?? null, period: period === "all" ? null : period };
  const [board, options] = await Promise.all([taskBoard(filter, today), taskOptions()]);
  const all: TaskCard[] = TASK_STATUSES.flatMap((s) => board[s]);
  // A card opened from a link may sit outside the current filters: look it up on the whole board then.
  let open = sp.task ? all.find((t) => t.id === sp.task) ?? null : null;
  if (sp.task && !open) { const whole = await taskBoard({}, today); open = TASK_STATUSES.flatMap((s) => whole[s]).find((t) => t.id === sp.task) ?? null; }
  const history = open ? (await taskHistory(open.id)).map((h) => ({ id: h.id, at: h.at.toISOString(), field: h.field, before: h.before, after: h.after })) : [];
  const href = (over: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...sp, task: undefined, ...over })) if (v) q.set(k, v);
    return `/tasks${q.size ? `?${q}` : ""}`;
  };
  const chip = (on: boolean) => cn("rounded-full border px-3 py-1 text-sm", on ? "border-accent bg-accent-soft text-accent" : "border-border text-muted hover:bg-surface-hover");
  const periodsView = sp.view === "periods";
  const range = periodRange(period, today);
  const sel = (name: string, value: string | undefined, opts: [string, string][], label: string) => <FilterSelect name={name} value={value ?? ""} options={opts} label={label} />;
  // Grouping for «По периодам»: by the month of the due date (else the start), cards without dates last.
  const groups = new Map<string, TaskCard[]>();
  for (const t of all) { const k = (t.dueDate ?? t.startDate)?.slice(0, 7) ?? "none"; groups.set(k, [...(groups.get(k) ?? []), t]); }
  const groupKeys = [...groups.keys()].sort((a, b) => (a === "none" ? 1 : b === "none" ? -1 : a.localeCompare(b)));

  return (
    <>
      <PageHeader title="Задачи" sub={`Борда команды: что делаем, кто, на что влияем и где. Перетаскивайте карточки между колонками · ${all.length} ${all.length === 1 ? "задача" : all.length < 5 ? "задачи" : "задач"}${range ? ` · ${period.length === 7 ? monthLabel(period) : TASK_PERIOD_LABEL[period as keyof typeof TASK_PERIOD_LABEL].toLowerCase()}` : ""}`} />
      <nav className="flex gap-1 border-b border-border" aria-label="Вид">
        {([["board", "Борда"], ["periods", "По периодам"]] as const).map(([v, l]) => (
          <Link key={v} href={href({ view: v === "board" ? undefined : v })} data-view={v}
            className={cn("-mb-px border-b-2 px-3 py-2 text-sm font-medium", (v === "periods") === periodsView ? "border-accent text-accent" : "border-transparent text-muted hover:text-text")}>{l}</Link>
        ))}
      </nav>
      <div className="flex flex-wrap items-center gap-2" data-testid="task-periods">
        {TASK_PERIODS.map((p) => <Link key={p} href={href({ period: p === "all" ? undefined : p })} className={chip(period === p)} data-period={p}>{TASK_PERIOD_LABEL[p]}</Link>)}
        <PeriodMonth value={period.length === 7 ? period : ""} />
      </div>
      <div className="flex flex-wrap items-center gap-2" data-testid="task-filters">
        <MineChip team={options.team.map((m) => m.name)} active={sp.assignee ?? null} />
        {sel("assignee", sp.assignee, [["-", "Без исполнителя"], ...options.team.map((m) => [m.name, m.name] as [string, string])], "Исполнитель")}
        {sel("impact", sp.impact, TASK_IMPACTS.map((k) => [k, TASK_IMPACT_LABEL[k]]), "На что влияем")}
        {sel("site", sp.site, options.sites.map((s) => [s.id, s.domain]), "Сайт")}
        {sel("format", sp.format, Object.keys(FORMAT_LABEL).map((f) => [f, FORMAT_LABEL[f]]), "Формат")}
        {sel("advertiser", sp.advertiser, options.advertisers.map((a) => [a.id, a.name]), "Рекламодатель")}
        {(sp.assignee || sp.impact || sp.site || sp.format || sp.advertiser) && <Link href={href({ assignee: undefined, impact: undefined, site: undefined, format: undefined, advertiser: undefined })} className="text-sm text-accent hover:underline">Сбросить</Link>}
      </div>
      {periodsView ? (
        <div className="space-y-4" data-testid="task-periods-view">
          {groupKeys.length === 0 && <p className="text-sm text-muted">Задач нет</p>}
          {groupKeys.map((k) => (
            <Section key={k} title={k === "none" ? "Без срока" : monthLabel(k)} sub={TASK_STATUSES.map((s) => `${TASK_STATUS_LABEL[s]} ${groups.get(k)!.filter((t) => t.status === s).length}`).join(" · ")}>
              <ul className="-mx-5 divide-y divide-border/60">
                {groups.get(k)!.sort((a, b) => TASK_STATUSES.indexOf(a.status) - TASK_STATUSES.indexOf(b.status)).map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center gap-x-3 px-5 py-2 text-sm">
                    <span className="w-28 shrink-0 text-xs text-muted">{TASK_STATUS_LABEL[t.status as TaskStatus]}</span>
                    <Link href={href({ view: undefined, task: t.id })} className="font-medium hover:text-accent">{t.title}</Link>
                    {t.assignee && <span className="text-xs text-muted">{t.assignee}</span>}
                    {t.site && <span className="text-xs text-muted">{t.site.domain}</span>}
                    <span className="num ml-auto text-xs text-muted">{t.dueDate ?? t.startDate ?? ""}</span>
                  </li>
                ))}
              </ul>
            </Section>
          ))}
        </div>
      ) : (
        <TaskBoard board={board} options={options} open={open} history={history} today={today} />
      )}
    </>
  );
}
