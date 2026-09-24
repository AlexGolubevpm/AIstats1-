"use client";
// Form bound to a server action returning ActionResult: field error under the field,
// success toast and onDone (close the Sheet) on ok.
import { createContext, useActionState, useContext, useEffect, useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import type { ActionResult } from "@/server/actions/result";

const ErrCtx = createContext<ActionResult>({});
export const useFormResult = () => useContext(ErrCtx);

export function ActionForm({ action, children, submit, onDone, className, cancel }: {
  action: (s: ActionResult, f: FormData) => Promise<ActionResult>; children: ReactNode; submit: string; onDone?: (r: ActionResult) => void;
  className?: string; cancel?: () => void;
}) {
  const [state, run, pending] = useActionState(action, {});
  const toast = useToast();
  const seen = useRef<ActionResult>(state);
  useEffect(() => {
    if (state === seen.current) return;
    seen.current = state;
    if (state.ok) { toast(state.message ?? "Сохранено"); onDone?.(state); }
    else if (state.error && !state.field) toast(state.error, "error");
  }, [state, toast, onDone]);
  return (
    <ErrCtx.Provider value={state}>
      <form action={run} className={className ?? "flex flex-col gap-4"}>
        {children}
        <div className="flex justify-end gap-2 pt-2">
          {cancel && <Button type="button" onClick={cancel}>Отмена</Button>}
          <Button variant="primary" disabled={pending}>{pending ? "Сохраняем…" : submit}</Button>
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
