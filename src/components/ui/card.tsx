import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

export function Card({ className, ...p }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("card", className)} {...p} />;
}

/** Block with an H2 title and optional actions on the right (design system: one card per block). */
export function Section({ title, actions, children, className, sub }: { title: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; sub?: ReactNode }) {
  return (
    <section className={cn("card flex flex-col", className)}>
      <header className="flex flex-wrap items-center justify-between gap-2 px-5 pt-4 pb-3">
        <div>
          <h2 className="text-[15px] leading-[22px] font-semibold">{title}</h2>
          {sub && <p className="text-xs text-muted">{sub}</p>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </header>
      <div className="min-w-0 flex-1 px-5 pb-4">{children}</div>
    </section>
  );
}
