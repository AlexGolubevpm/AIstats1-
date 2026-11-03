// The team's task board (ADR 0021): create, edit, move between columns, the team list. Every change is audited.
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { RuleError, parseDecimal } from "@/server/domain/errors";
import { impactOfMetric, positionBetween, TASK_IMPACTS, TASK_PRIORITIES, TASK_STATUSES, type TaskImpact, type TaskPriority, type TaskStatus } from "@/server/domain/tasks";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const d = (s: string) => new Date(`${s}T00:00:00Z`);

export interface TaskInput {
  title: string; description?: string | null; status?: string; assignee?: string | null; impact?: string | null; impactMonth?: string | null; priority?: string;
  advertiser?: string | null; format?: string | null; siteId?: string | null; hypothesisId?: string | null; startDate?: string | null; dueDate?: string | null;
}

/** A name typed into «Исполнитель» joins the team list once; the list is what the field offers next time. */
export async function ensureMember(db: PrismaClient, name: string | null | undefined): Promise<string | null> {
  const n = name?.trim().replace(/\s+/g, " ");
  if (!n) return null;
  if (n.length > 60) throw new RuleError("assignee", "Имя — до 60 символов", "assignee");
  await db.teamMember.upsert({ where: { name: n }, create: { name: n }, update: {} });
  return n;
}

async function fields(db: PrismaClient, i: TaskInput) {
  const title = i.title.trim();
  if (!title) throw new RuleError("title", "Назовите задачу", "title");
  if (i.status && !TASK_STATUSES.includes(i.status as TaskStatus)) throw new RuleError("status", "Неизвестная колонка", "status");
  if (i.impact && !TASK_IMPACTS.includes(i.impact as TaskImpact)) throw new RuleError("impact", "Неизвестное «на что влияем»", "impact");
  if (i.priority && !TASK_PRIORITIES.includes(i.priority as TaskPriority)) throw new RuleError("priority", "Неизвестный приоритет", "priority");
  for (const k of ["startDate", "dueDate"] as const) if (i[k] && !DATE.test(i[k]!)) throw new RuleError(k, "Дата — ГГГГ-ММ-ДД", k);
  if (i.startDate && i.dueDate && i.startDate > i.dueDate) throw new RuleError("dueDate", "Срок раньше начала", "dueDate");
  if (i.siteId && !(await db.site.findUnique({ where: { id: i.siteId } }))) throw new RuleError("siteId", "Сайт не найден", "siteId");
  if (i.hypothesisId && !(await db.hypothesis.findUnique({ where: { id: i.hypothesisId } }))) throw new RuleError("hypothesisId", "Гипотеза не найдена", "hypothesisId");
  let impactMonth: string | null = null;
  if (i.impactMonth) {
    const v = parseDecimal(i.impactMonth);
    if (!v.isFinite() || v.lt(0)) throw new RuleError("impactMonth", "Эффект — число, $ в месяц", "impactMonth");
    impactMonth = v.toFixed(2);
  }
  const adv = i.advertiser?.trim();
  const advertiserId = adv ? (await db.advertiser.upsert({ where: { name: adv }, create: { name: adv }, update: {} })).id : null;
  return {
    title, description: i.description?.trim() || null, assignee: await ensureMember(db, i.assignee), impact: (i.impact || null) as TaskImpact | null, impactMonth,
    priority: (i.priority || "NORMAL") as TaskPriority, advertiserId, format: (i.format || null) as never, siteId: i.siteId || null, hypothesisId: i.hypothesisId || null,
    startDate: i.startDate ? d(i.startDate) : null, dueDate: i.dueDate ? d(i.dueDate) : null,
  };
}

/** A new card goes to the bottom of its column. */
export async function createTask(db: PrismaClient, i: TaskInput): Promise<string> {
  const f = await fields(db, i);
  const status = (i.status || "BACKLOG") as TaskStatus;
  const last = await db.task.findFirst({ where: { status }, orderBy: { position: "desc" }, select: { position: true } });
  const t = await db.task.create({ data: { ...f, status, position: positionBetween(last?.position ?? null, null), doneAt: status === "DONE" ? new Date() : null } });
  await db.auditLog.create({ data: { entity: "Task", entityId: t.id, field: "created", after: `${status} · ${t.title}` } });
  return t.id;
}

const show = (v: unknown) => (v == null || v === "" ? null : v instanceof Date ? v.toISOString().slice(0, 10) : v instanceof Prisma.Decimal ? v.toString() : String(v));
const EDITABLE = ["title", "description", "assignee", "impact", "impactMonth", "priority", "advertiserId", "format", "siteId", "hypothesisId", "startDate", "dueDate"] as const;

/** The card's panel: every field; one audit line per changed field. Status goes through moveTask. */
export async function updateTask(db: PrismaClient, id: string, i: TaskInput): Promise<number> {
  const before = await db.task.findUniqueOrThrow({ where: { id } });
  const f = await fields(db, i);
  const changes = EDITABLE.filter((k) => k === "impactMonth" ? Number(show(before[k]) ?? 0) !== Number(show(f[k]) ?? 0) : show(before[k]) !== show(f[k]));
  if (i.status && i.status !== before.status) await moveTask(db, id, i.status as TaskStatus);
  if (!changes.length) return 0;
  await db.task.update({ where: { id }, data: f });
  await db.auditLog.createMany({ data: changes.map((k) => ({ entity: "Task", entityId: id, field: k, before: show(before[k]), after: show(f[k]) })) });
  return changes.length;
}

/**
 * Drag and drop: the card goes to `status`, between the cards `beforeId` and `afterId` of that column (either may be
 * missing — top or bottom). Moving into «Готово» stamps doneAt; out of it clears it.
 */
export async function moveTask(db: PrismaClient, id: string, status: TaskStatus, beforeId?: string | null, afterId?: string | null): Promise<void> {
  if (!TASK_STATUSES.includes(status)) throw new RuleError("status", "Неизвестная колонка", "status");
  const t = await db.task.findUniqueOrThrow({ where: { id } });
  const [b, a] = await Promise.all([beforeId ? db.task.findUnique({ where: { id: beforeId } }) : null, afterId ? db.task.findUnique({ where: { id: afterId } }) : null]);
  let position: number;
  if (b || a) position = positionBetween(b?.position ?? null, a?.position ?? null);
  else if (t.status === status) position = t.position;
  else position = positionBetween((await db.task.findFirst({ where: { status }, orderBy: { position: "desc" }, select: { position: true } }))?.position ?? null, null);
  await db.task.update({ where: { id }, data: { status, position, doneAt: status === "DONE" ? t.doneAt ?? new Date() : null } });
  if (t.status !== status) await db.auditLog.create({ data: { entity: "Task", entityId: id, field: "status", before: t.status, after: status } });
}

export async function deleteTask(db: PrismaClient, id: string): Promise<void> {
  const t = await db.task.findUniqueOrThrow({ where: { id } });
  await db.task.delete({ where: { id } });
  await db.auditLog.create({ data: { entity: "Task", entityId: id, field: "deleted", before: `${t.status} · ${t.title}`, after: null } });
}

/** «Создать задачу» on a hypothesis: its title, site, format, effect and what it moves (by its metric). */
export async function taskFromHypothesis(db: PrismaClient, hypothesisId: string): Promise<string> {
  const h = await db.hypothesis.findUniqueOrThrow({ where: { id: hypothesisId } });
  return createTask(db, { title: h.title, description: h.hypothesis, hypothesisId, siteId: h.siteId, format: h.format, impact: impactOfMetric(h.metric),
    impactMonth: h.impactMonth && Number(h.impactMonth) > 0 ? h.impactMonth.toString() : null, status: "BACKLOG" });
}

export async function renameMember(db: PrismaClient, id: string, name: string): Promise<void> {
  const m = await db.teamMember.findUniqueOrThrow({ where: { id } });
  const n = name.trim().replace(/\s+/g, " ");
  if (!n) throw new RuleError("name", "Имя не может быть пустым", "name");
  if (n === m.name) return;
  if (await db.teamMember.findUnique({ where: { name: n } })) throw new RuleError("name", "Такое имя уже есть", "name");
  await db.$transaction([db.teamMember.update({ where: { id }, data: { name: n } }), db.task.updateMany({ where: { assignee: m.name }, data: { assignee: n } })]);
}

/** Removing a person keeps their tasks, unassigned. */
export async function removeMember(db: PrismaClient, id: string): Promise<void> {
  const m = await db.teamMember.findUniqueOrThrow({ where: { id } });
  await db.$transaction([db.task.updateMany({ where: { assignee: m.name }, data: { assignee: null } }), db.teamMember.delete({ where: { id } })]);
}
