"use server";
import { revalidatePath } from "next/cache";
import { db } from "@/server/db";
import type { TaskStatus } from "@/server/domain/tasks";
import { requireSession } from "@/server/session";
import { createTask, deleteTask, moveTask, removeMember, renameMember, taskFromHypothesis, updateTask, type TaskInput } from "@/server/services/tasks";
import { guarded, money, opt, str, type ActionResult } from "./result";

const touched = () => { revalidatePath("/tasks"); revalidatePath("/", "layout"); revalidatePath("/hypotheses/[id]", "page"); };
const input = (f: FormData): TaskInput => ({
  title: str(f, "title"), description: opt(f, "description"), status: opt(f, "status") ?? undefined, assignee: opt(f, "assignee"), impact: opt(f, "impact"),
  impactMonth: opt(f, "impactMonth") ? money(f, "impactMonth") : null, priority: opt(f, "priority") ?? undefined, advertiser: opt(f, "advertiser"), format: opt(f, "format"),
  siteId: opt(f, "siteId"), hypothesisId: opt(f, "hypothesisId"), startDate: opt(f, "startDate"), dueDate: opt(f, "dueDate"),
});

export async function createTaskAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  await requireSession();
  return guarded(async () => { const id = await createTask(db, input(f)); touched(); return { ok: true, message: "Задача добавлена", data: { id } }; });
}

export async function updateTaskAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  await requireSession();
  return guarded(async () => { await updateTask(db, str(f, "id"), input(f)); touched(); return { ok: true, message: "Задача сохранена" }; });
}

/** Drag and drop on the board: a plain call, not a form. */
export async function moveTaskAction(id: string, status: TaskStatus, beforeId: string | null, afterId: string | null): Promise<ActionResult> {
  await requireSession();
  return guarded(async () => { await moveTask(db, id, status, beforeId, afterId); touched(); });
}

export async function deleteTaskAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  await requireSession();
  return guarded(async () => { await deleteTask(db, str(f, "id")); touched(); return { ok: true, message: "Задача удалена" }; });
}

export async function taskFromHypothesisAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  await requireSession();
  return guarded(async () => { await taskFromHypothesis(db, str(f, "hypothesisId")); touched(); return { ok: true, message: "Задача в бэклоге" }; });
}

export async function renameMemberAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  await requireSession();
  return guarded(async () => { await renameMember(db, str(f, "id"), str(f, "name")); touched(); revalidatePath("/settings/team"); return { ok: true, message: "Имя сохранено" }; });
}

export async function removeMemberAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  await requireSession();
  return guarded(async () => { await removeMember(db, str(f, "id")); touched(); revalidatePath("/settings/team"); return { ok: true, message: "Удалён из команды, его задачи без исполнителя" }; });
}
