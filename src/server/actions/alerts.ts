"use server";
import { revalidatePath } from "next/cache";
import { snoozeAlert } from "@/server/domain/alerts/rules";
import { db } from "@/server/db";
import { requireSession } from "@/server/session";

export async function snoozeAlertAction(id: string): Promise<void> {
  await requireSession();
  await snoozeAlert(db, id);
  revalidatePath("/alerts"); revalidatePath("/sites/[domain]", "page");
}

export async function unsnoozeAlertAction(id: string): Promise<void> {
  await requireSession();
  await db.alert.update({ where: { id }, data: { snoozedUntil: null, snoozedRisk: null } });
  revalidatePath("/alerts"); revalidatePath("/sites/[domain]", "page");
}
