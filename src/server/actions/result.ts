// Shared shape of server action results: forms show `error` next to `field`, toasts use `message`.
import { RuleError } from "@/server/domain/errors";

export type ActionResult = { ok?: boolean; error?: string; field?: string; message?: string; data?: Record<string, unknown> };

export async function guarded(fn: () => Promise<ActionResult | void>): Promise<ActionResult> {
  try {
    return (await fn()) ?? { ok: true };
  } catch (e) {
    if (e instanceof RuleError) return { error: e.message, field: e.field };
    // Next.js redirect()/notFound() must propagate.
    if (e && typeof e === "object" && "digest" in e) throw e;
    console.error(e);
    return { error: e instanceof Error ? e.message : "Не удалось сохранить" };
  }
}

export const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
export const opt = (f: FormData, k: string) => str(f, k) || null;
export const int = (f: FormData, k: string) => (str(f, k) === "" ? null : Math.round(Number(str(f, k).replace(/[\s ]/g, ""))));
export const money = (f: FormData, k: string) => str(f, k).replace(/[\s $]/g, "").replace(",", ".");
