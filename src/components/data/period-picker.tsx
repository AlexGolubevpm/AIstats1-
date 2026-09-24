"use client";
import { Calendar, ChevronDown } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import * as P from "@radix-ui/react-popover";
import { PRESETS, type Preset } from "@/lib/period";
import { fmtDate } from "@/lib/format";
import { cn } from "@/lib/cn";

/** Presets + custom range. Value lives in the URL (?preset= or ?from=&to=); defaults are not written. */
export function PeriodPicker({ from, to, preset, extra = [] }: { from: string; to: string; preset?: Preset; extra?: { id: Preset; label: string }[] }) {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(from);
  const [t, setT] = useState(to);
  const go = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(sp.toString());
    for (const k of ["preset", "from", "to"]) next.delete(k);
    for (const k of [...next.keys()]) if (k.endsWith(".page")) next.delete(k);
    for (const [k, v] of Object.entries(patch)) if (v) next.set(k, v);
    router.push(`${pathname}${next.size ? `?${next}` : ""}`);
    setOpen(false);
  };
  const all = [...PRESETS, ...extra];
  const label = all.find((p) => p.id === preset)?.label ?? "Свой период";
  return (
    <P.Root open={open} onOpenChange={setOpen}>
      <P.Trigger className="card inline-flex h-10 items-center gap-2 px-3 text-sm hover:bg-surface-hover">
        <Calendar className="size-4 text-muted" />
        <span className="num">{fmtDate(from)} — {fmtDate(to)}</span>
        <span className="h-5 w-px bg-border" />
        <span className="text-muted">{label}</span>
        <ChevronDown className="size-4 text-muted" />
      </P.Trigger>
      <P.Portal>
        <P.Content align="end" sideOffset={6} className="card z-50 w-72 p-2">
          <div className="grid gap-0.5">
            {all.map((p) => (
              <button key={p.id} onClick={() => go({ preset: p.id })}
                className={cn("rounded-md px-3 py-1.5 text-left text-sm hover:bg-surface-hover", preset === p.id && "bg-accent-soft text-accent")}>{p.label}</button>
            ))}
          </div>
          <div className="mt-2 border-t border-border px-1 pt-3">
            <div className="mb-2 text-xs font-medium text-muted">Свой период</div>
            <div className="flex items-center gap-2">
              <input type="date" value={f} onChange={(e) => setF(e.target.value)} className="h-8 flex-1 rounded-md border border-border bg-surface px-2 text-xs" />
              <input type="date" value={t} onChange={(e) => setT(e.target.value)} className="h-8 flex-1 rounded-md border border-border bg-surface px-2 text-xs" />
            </div>
            <button disabled={!f || !t || f > t} onClick={() => go({ from: f, to: t })}
              className="mt-2 h-8 w-full rounded-md bg-accent text-sm font-medium text-white disabled:opacity-50">Применить</button>
          </div>
        </P.Content>
      </P.Portal>
    </P.Root>
  );
}
