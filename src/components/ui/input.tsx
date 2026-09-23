import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

const base = "h-9 w-full rounded-md border border-border bg-surface px-3 text-sm text-text placeholder:text-faint focus:border-accent focus:outline-none disabled:opacity-60";

export function Input({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(base, "num", className)} {...p} />;
}
export function Select({ className, children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(base, "pr-8", className)} {...p}>{children}</select>;
}
export function Textarea({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(base, "h-auto min-h-24 py-2 font-mono text-xs", className)} {...p} />;
}

/** Label above, error below (design system forms pattern). */
export function Field({ label, error, hint, children, className }: { label: ReactNode; error?: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cn("flex flex-col gap-1", className)}>
      <span className="text-xs font-medium tracking-[0.01em] text-muted">{label}</span>
      {children}
      {error ? <span className="text-xs text-negative">{error}</span> : hint ? <span className="text-xs text-faint">{hint}</span> : null}
    </label>
  );
}
