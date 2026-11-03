// The team's task board (ADR 0021): columns, labels, periods and the order of cards. Pure — no database here.
export const TASK_STATUSES = ["BACKLOG", "PLANNED", "IN_PROGRESS", "TESTING", "DONE"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_STATUS_LABEL: Record<TaskStatus, string> = { BACKLOG: "Бэклог", PLANNED: "Запланировано", IN_PROGRESS: "В работе", TESTING: "Тест", DONE: "Готово" };

export const TASK_IMPACTS = ["REVENUE", "COST", "MARGIN", "TRAFFIC", "QUALITY", "OTHER"] as const;
export type TaskImpact = (typeof TASK_IMPACTS)[number];
export const TASK_IMPACT_LABEL: Record<TaskImpact, string> = { REVENUE: "Выручка", COST: "Расходы", MARGIN: "Маржа", TRAFFIC: "Трафик", QUALITY: "Качество", OTHER: "Другое" };
/** Tag colours: the design system's soft tones. */
export const TASK_IMPACT_TONE: Record<TaskImpact, string> = {
  REVENUE: "bg-positive-soft text-positive", COST: "bg-negative-soft text-negative", MARGIN: "bg-accent-soft text-accent",
  TRAFFIC: "bg-warning-soft text-warning", QUALITY: "bg-surface-2 text-muted", OTHER: "bg-surface-2 text-muted",
};

export const TASK_PRIORITIES = ["LOW", "NORMAL", "HIGH"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export const TASK_PRIORITY_LABEL: Record<TaskPriority, string> = { LOW: "Низкий", NORMAL: "Обычный", HIGH: "Высокий" };

/** «На что влияем» from a hypothesis's metric: cost metrics → расходы, view rate → качество, the rest → выручка. */
export function impactOfMetric(metric: string | null | undefined): TaskImpact {
  if (metric === "cost_per_1k" || metric === "cost_share") return "COST";
  if (metric === "margin") return "MARGIN";
  if (metric === "view_rate") return "QUALITY";
  return "REVENUE";
}

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const at = (s: string) => Date.parse(`${s}T00:00:00Z`);

export const TASK_PERIODS = ["all", "week", "month", "next_month"] as const;
export type TaskPeriodKey = (typeof TASK_PERIODS)[number];
export const TASK_PERIOD_LABEL: Record<TaskPeriodKey, string> = { all: "Все", week: "Эта неделя", month: "Этот месяц", next_month: "Следующий месяц" };

/** The dates of a period: `week` — Monday to Sunday of today; `month`, `next_month`; or a month `YYYY-MM`. `all` — no bounds. */
export function periodRange(period: string, today: string): { from: string; to: string } | null {
  const m = today.slice(0, 7);
  const monthRange = (mm: string) => { const [y, mo] = mm.split("-").map(Number); return { from: `${mm}-01`, to: iso(Date.UTC(y, mo, 0)) }; };
  if (period === "week") {
    const dow = (new Date(at(today)).getUTCDay() + 6) % 7; // Monday = 0
    return { from: iso(at(today) - dow * DAY), to: iso(at(today) + (6 - dow) * DAY) };
  }
  if (period === "month") return monthRange(m);
  if (period === "next_month") { const [y, mo] = m.split("-").map(Number); return monthRange(new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 7)); }
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return monthRange(period);
  return null;
}

/** A task is in a period when its dates (start–due; one of them alone is a single day) overlap it; a task without dates only in «Все». */
export function taskInPeriod(t: { startDate: string | null; dueDate: string | null }, range: { from: string; to: string } | null): boolean {
  if (!range) return true;
  const from = t.startDate ?? t.dueDate, to = t.dueDate ?? t.startDate;
  if (!from || !to) return false;
  return from <= range.to && to >= range.from;
}

/** Position of a card dropped between two neighbours (either may be missing: top or bottom of the column). */
export function positionBetween(before: number | null, after: number | null): number {
  if (before == null && after == null) return 1000;
  if (before == null) return after! - 1000;
  if (after == null) return before + 1000;
  return (before + after) / 2;
}

export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
