"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";

/** Sets or clears one URL parameter of /tasks, keeping the rest (the open card closes). */
function useParam() {
  const router = useRouter(), path = usePathname(), sp = useSearchParams();
  return (name: string, value: string | null) => {
    const q = new URLSearchParams(sp.toString());
    q.delete("task");
    if (value) q.set(name, value); else q.delete(name);
    router.push(`${path}${q.size ? `?${q}` : ""}`, { scroll: false });
  };
}

export function FilterSelect({ name, value, options, label }: { name: string; value: string; options: [string, string][]; label: string }) {
  const set = useParam();
  return (
    <select value={value} onChange={(e) => set(name, e.target.value || null)} aria-label={label} data-filter={name}
      className={cn("h-8 max-w-48 rounded-full border bg-surface px-3 text-sm", value ? "border-accent text-accent" : "border-border text-muted")}>
      <option value="">{label}</option>{options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}

export function PeriodMonth({ value }: { value: string }) {
  const set = useParam();
  return <input type="month" value={value} onChange={(e) => set("period", e.target.value || null)} aria-label="Месяц"
    className={cn("h-8 rounded-full border bg-surface px-3 text-sm", value ? "border-accent text-accent" : "border-border text-muted")} data-period-month />;
}

const KEY = "tasks.me";

/** «Мои»: the name picked once is remembered in this browser; the chip filters the board by it. */
export function MineChip({ team, active }: { team: string[]; active: string | null }) {
  const set = useParam();
  const [me, setMe] = useState<string | null>(null);
  useEffect(() => { try { setMe(localStorage.getItem(KEY)); } catch { /* private mode */ } }, []);
  if (!team.length) return null;
  if (!me || !team.includes(me)) {
    return (
      <select value="" onChange={(e) => { const v = e.target.value; if (!v) return; try { localStorage.setItem(KEY, v); } catch { /* ignore */ } setMe(v); set("assignee", v); }}
        aria-label="Кто я" className="h-8 rounded-full border border-dashed border-border bg-surface px-3 text-sm text-muted" data-mine-pick>
        <option value="">Мои: кто я?</option>{team.map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
    );
  }
  const on = active === me;
  return <button type="button" onClick={() => set("assignee", on ? null : me)} data-mine
    className={cn("rounded-full border px-3 py-1 text-sm", on ? "border-accent bg-accent-soft text-accent" : "border-border text-muted hover:bg-surface-hover")}>Мои · {me}</button>;
}
