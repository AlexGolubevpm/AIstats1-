// The task board (docs/product/03-pages.md#tasks, ADR 0021): cards by column, filters, periods, one card with its history.
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/server/db";
import { periodRange, taskInPeriod, TASK_STATUSES, type TaskImpact, type TaskStatus } from "@/server/domain/tasks";

export interface TaskFilter { assignee?: string | null; siteId?: string | null; format?: string | null; advertiserId?: string | null; impact?: string | null; period?: string | null }

export interface TaskCard {
  id: string; title: string; status: TaskStatus; position: number; assignee: string | null; impact: TaskImpact | null; impactMonth: number | null; priority: string;
  site: { id: string; domain: string } | null; format: string | null; advertiser: { id: string; name: string } | null; hypothesis: { id: string; title: string } | null;
  startDate: string | null; dueDate: string | null; doneAt: string | null; description: string | null;
}

const iso = (x: Date | null) => (x ? x.toISOString().slice(0, 10) : null);

/** Every card matching the filters, in column order; the period keeps the ones whose dates overlap it. */
export async function taskBoard(f: TaskFilter, today = new Date().toISOString().slice(0, 10)): Promise<Record<TaskStatus, TaskCard[]>> {
  const where: Prisma.TaskWhereInput = {
    ...(f.assignee === "-" ? { assignee: null } : f.assignee ? { assignee: f.assignee } : {}),
    ...(f.siteId ? { siteId: f.siteId } : {}), ...(f.format ? { format: f.format as never } : {}),
    ...(f.advertiserId ? { advertiserId: f.advertiserId } : {}), ...(f.impact ? { impact: f.impact as never } : {}),
  };
  const rows = await db.task.findMany({ where, orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    include: { site: { select: { id: true, domain: true } }, advertiser: { select: { id: true, name: true } }, hypothesis: { select: { id: true, title: true } } } });
  const range = f.period ? periodRange(f.period, today) : null;
  const board = Object.fromEntries(TASK_STATUSES.map((s) => [s, [] as TaskCard[]])) as Record<TaskStatus, TaskCard[]>;
  for (const t of rows) {
    const card: TaskCard = { id: t.id, title: t.title, status: t.status as TaskStatus, position: t.position, assignee: t.assignee, impact: t.impact as TaskImpact | null,
      impactMonth: t.impactMonth == null ? null : Number(t.impactMonth), priority: t.priority, site: t.site, format: t.format, advertiser: t.advertiser, hypothesis: t.hypothesis,
      startDate: iso(t.startDate), dueDate: iso(t.dueDate), doneAt: t.doneAt?.toISOString() ?? null, description: t.description };
    if (taskInPeriod(card, range)) board[card.status].push(card);
  }
  return board;
}

/** What the filters and the card panel offer. */
export async function taskOptions() {
  const [team, sites, advertisers] = await Promise.all([
    db.teamMember.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.site.findMany({ where: { status: { not: "ARCHIVED" } }, orderBy: { domain: "asc" }, select: { id: true, domain: true } }),
    db.advertiser.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  return { team, sites, advertisers };
}

export async function taskHistory(id: string) {
  return db.auditLog.findMany({ where: { entity: "Task", entityId: id }, orderBy: { at: "desc" }, take: 50 });
}

export const tasksInWork = () => db.task.count({ where: { status: "IN_PROGRESS" } });

export const tasksOfHypothesis = (hypothesisId: string) =>
  db.task.findMany({ where: { hypothesisId }, orderBy: { createdAt: "asc" }, select: { id: true, title: true, status: true, assignee: true } });
