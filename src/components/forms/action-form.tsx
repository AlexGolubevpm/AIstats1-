"use client";
// Form bound to a server action returning ActionResult: field error under the field,
// success toast and onDone (close the Sheet) on ok.
import { createContext, useActionState, useContext, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import type { ActionResult } from "@/server/actions/result";

const ErrCtx = createContext<ActionResult>({});
export const useFormResult = () => useContext(ErrCtx);

export function ActionForm({ action, children, submit, onDone, className, cancel, submitVariant = "primary", submitSize }: {
  action: (s: ActionResult, f: FormData) => Promise<ActionResult>; children: ReactNode; submit: string; onDone?: (r: ActionResult) => void;
  className?: string; cancel?: () => void; submitVariant?: "primary" | "secondary" | "ghost" | "destructive"; submitSize?: "sm" | "md";
}) {
  const toast = useToast();
  // Toast and onDone fire right when the action answers, not in an effect: the action's
  // revalidation can unmount this form (e.g. the "к вводу" row disappears) before an effect runs.
  const [state, run, pending] = useActionState(async (prev: ActionResult, f: FormData) => {
    const r = await action(prev, f);
    if (r.ok) { toast(r.message ?? "Сохранено"); onDone?.(r); }
    else if (r.error && !r.field) toast(r.error, "error");
    return r;
  }, {});
  return (
    <ErrCtx.Provider value={state}>
      <form action={run} className={className ?? "flex flex-col gap-4"}>
        {children}
        <div className="flex justify-end gap-2 pt-2">
          {cancel && <Button type="button" onClick={cancel}>Отмена</Button>}
          <Button variant={submitVariant} size={submitSize} disabled={pending}>{pending ? "Сохраняем…" : submit}</Button>
        </div>
      </form>
    </ErrCtx.Provider>
  );
}

/** Field whose error comes from the action result by name. */
export function FieldErr({ name }: { name: string }) {
  const r = useFormResult();
  return r.field === name && r.error ? <p className="text-xs text-negative">{r.error}</p> : null;
}

/** Field that shows the action's error when it names this field. */
export function FormField({ name, label, hint, children, className }: { name: string; label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  const r = useFormResult();
  return <Field label={label} hint={hint} className={className} error={r.field === name ? r.error : undefined}>{children}</Field>;
}
