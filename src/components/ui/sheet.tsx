"use client";
import * as D from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Side panel for forms: the table underneath stays visible for reference. */
export function Sheet({ open, onOpenChange, title, description, children, width = "max-w-xl" }: {
  open: boolean; onOpenChange: (v: boolean) => void; title: ReactNode; description?: ReactNode; children: ReactNode; width?: string;
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-slate-900/20" />
        <D.Content className={cn("fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-border bg-surface shadow-xl", width)}>
          <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-4">
            <div>
              <D.Title className="text-base font-semibold">{title}</D.Title>
              {description && <D.Description className="mt-0.5 text-sm text-muted">{description}</D.Description>}
            </div>
            <D.Close className="rounded p-1 text-muted hover:bg-surface-hover" aria-label="Закрыть"><X className="size-4" /></D.Close>
          </div>
          <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

/** Confirmation only for irreversible actions; the text names the object. */
export function Confirm({ open, onOpenChange, title, body, confirmLabel, onConfirm, destructive }: {
  open: boolean; onOpenChange: (v: boolean) => void; title: string; body?: ReactNode; confirmLabel: string; onConfirm: () => void; destructive?: boolean;
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-slate-900/30" />
        <D.Content className="fixed top-1/2 left-1/2 z-50 w-[92vw] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-6 shadow-xl">
          <D.Title className="text-base font-semibold">{title}</D.Title>
          {body && <D.Description asChild><div className="mt-2 text-sm text-muted">{body}</div></D.Description>}
          <div className="mt-6 flex justify-end gap-2">
            <D.Close className="h-9 rounded-md border border-border px-4 text-sm hover:bg-surface-hover">Отмена</D.Close>
            <button onClick={() => { onConfirm(); onOpenChange(false); }}
              className={cn("h-9 rounded-md px-4 text-sm font-medium text-white", destructive ? "bg-negative" : "bg-accent")}>{confirmLabel}</button>
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
