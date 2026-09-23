"use server";
import { revalidatePath } from "next/cache";
import { db } from "@/server/db";
import { requireSession } from "@/server/session";
import { recordAsgPayout } from "@/server/services/finance";
import { guarded, money, opt, str, type ActionResult } from "./result";

export async function asgPayoutAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  await requireSession();
  return guarded(async () => {
    const r = await recordAsgPayout(db, { month: str(f, "month"), amountReceived: money(f, "amountReceived"), receivedAt: str(f, "receivedAt"), note: opt(f, "note") });
    revalidatePath("/finance");
    const diff = r.diff == null ? "" : ` · расхождение ${(r.diff * 100).toFixed(1)}%`;
    return { ok: true, message: `Выплата внесена, месяц подтверждён${diff}` };
  });
}
