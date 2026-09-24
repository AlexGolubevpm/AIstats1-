import Link from "next/link";
import type { ReactNode } from "react";
import { PeriodPicker } from "@/components/data/period-picker";
import type { Period, Preset } from "@/lib/period";

export function PageHeader({ title, sub, crumbs, badges, period, extraPresets, actions }: {
  title: ReactNode; sub?: ReactNode; crumbs?: { href: string; label: string }[]; badges?: ReactNode; period?: Period;
  extraPresets?: { id: Preset; label: string }[]; actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        {crumbs && (
          <nav className="mb-1 flex items-center gap-1 text-xs text-muted" aria-label="Хлебные крошки">
            {crumbs.map((c, i) => <span key={c.href} className="flex items-center gap-1">{i > 0 && "/"}<Link href={c.href} className="hover:text-accent">{c.label}</Link></span>)}
          </nav>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-[24px] leading-8 font-semibold tracking-[-0.01em]">{title}</h1>
          {badges}
        </div>
        {sub && <p className="mt-0.5 text-sm text-muted">{sub}</p>}
      </div>
      <div className="flex items-center gap-2">
        {actions}
        {period && <PeriodPicker from={period.from} to={period.to} preset={period.preset} extra={extraPresets} />}
      </div>
    </header>
  );
}
