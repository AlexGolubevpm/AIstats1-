import type { LucideIcon } from "lucide-react";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { fmtCompact, fmtDelta, fmtMoney, fmtPercent, DASH } from "@/lib/format";
import { Sparkline } from "./charts";

export interface KpiProps {
  label: string;
  value: number | null;
  format: "money" | "percent" | "compact" | "decimal" | "moneyPrecise" | "count";
  delta?: number | null;
  deltaMode?: "percent" | "pp";
  spark?: (number | null)[];
  tone?: "auto" | "neutral" | "inverse";
  icon?: LucideIcon;
  color?: string;
  emphasis?: boolean;
  sub?: string;
  warn?: string;
  negativeFrame?: boolean;
}

function fmt(v: number | null, f: KpiProps["format"]) {
  if (v == null) return DASH;
  switch (f) {
    case "money": return Math.abs(v) >= 1_000_000 ? `${v < 0 ? "−" : ""}$${fmtCompact(Math.abs(v))}` : fmtMoney(v).replace(/\.\d\d$/, "");
    case "moneyPrecise": return fmtMoney(v);
    case "percent": return fmtPercent(v, true);
    case "compact": return fmtCompact(v);
    case "decimal": return v.toFixed(2);
    case "count": return v.toLocaleString("ru-RU");
  }
}

export function KpiCard({ label, value, format, delta, deltaMode = "percent", spark, tone = "auto", icon: Icon, color = "var(--accent)", emphasis, sub, warn, negativeFrame }: KpiProps) {
  const good = delta == null ? null : tone === "inverse" ? delta < 0 : delta > 0;
  const deltaCls = tone === "neutral" || delta == null || delta === 0 ? "text-muted" : good ? "text-positive" : "text-negative";
  return (
    <div className={cn("card flex min-w-0 flex-col gap-2 p-4", emphasis && "sm:col-span-2", negativeFrame && "border-negative/60")}>
      <div className="flex items-center gap-2 text-[13px] text-muted">
        {Icon && <span className="grid size-7 place-items-center rounded-lg" style={{ background: `color-mix(in srgb, ${color} 12%, transparent)`, color }}><Icon className="size-4" /></span>}
        <span className="truncate">{label}</span>
        {warn && <Tip content={warn}><span className="text-warning">⚠</span></Tip>}
      </div>
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div className={cn("num text-[28px] leading-9 font-semibold tracking-[-0.02em]", value != null && value < 0 && "text-negative")}>{fmt(value, format)}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs whitespace-nowrap" title="К предыдущему равному периоду">
            {delta != null && <span className={cn("num font-medium", deltaCls)}>{delta > 0 ? "↑" : delta < 0 ? "↓" : ""} {fmtDelta(delta, deltaMode).replace(/^[+−]/, "")}</span>}
            {sub && <span className="truncate text-muted">{sub}</span>}
          </div>
        </div>
        {spark && <Sparkline values={spark} color={color} />}
      </div>
    </div>
  );
}
