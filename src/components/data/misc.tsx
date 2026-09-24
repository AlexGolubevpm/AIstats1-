import { AlertTriangle, CircleAlert, DatabaseZap, FileCheck2, FileText, SearchX } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { fmtAgo, fmtMoney, fmtPercent } from "@/lib/format";
import { discrepancyLevel } from "@/lib/metrics";

/** Tabs are links: the active cut lives in ?by=. */
export function BreakdownTabs({ tabs, active, hrefFor }: { tabs: { id: string; label: string; count?: number }[]; active: string; hrefFor: (id: string) => string }) {
  return (
    <nav className="flex gap-1 border-b border-border" aria-label="Разрезы">
      {tabs.map((t) => (
        <Link key={t.id} href={hrefFor(t.id)} scroll={false} aria-current={t.id === active ? "page" : undefined}
          className={cn("-mb-px border-b-2 px-3 py-2 text-sm", t.id === active ? "border-accent font-medium text-accent" : "border-transparent text-muted hover:text-text")}>
          {t.label}{t.count != null && <span className="ml-1.5 text-xs text-faint">{t.count}</span>}
        </Link>
      ))}
    </nav>
  );
}

type EmptyKind = "no-data" | "ingest-failed" | "no-match";
export function EmptyState({ kind, lastOk, action }: { kind: EmptyKind; lastOk?: Date | string | null; action?: ReactNode }) {
  const map = {
    "no-data": { icon: DatabaseZap, title: "Нет данных за выбранный период", text: "Выберите другой период или проверьте, подключены ли источники." },
    "ingest-failed": { icon: CircleAlert, title: "Ингест не отработал", text: `Последний успешный: ${lastOk ? fmtAgo(lastOk) : "ни одного"}.` },
    "no-match": { icon: SearchX, title: "По фильтрам ничего не найдено", text: "Сбросьте фильтры или расширьте период." },
  }[kind];
  const Icon = map.icon;
  return (
    <div className="flex flex-col items-center gap-2 py-12 text-center">
      <span className="grid size-10 place-items-center rounded-full bg-surface-hover text-muted"><Icon className="size-5" /></span>
      <div className="font-medium">{map.title}</div>
      <p className="max-w-sm text-sm text-muted">{map.text}</p>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function AlertBadge({ level, title, message, link, meta }: { level: "WARNING" | "CRITICAL"; title: string; message: string; link: string; meta?: ReactNode }) {
  const crit = level === "CRITICAL";
  return (
    <Link href={link} className="group flex gap-3 rounded-lg p-2.5 hover:bg-surface-hover">
      <span className={cn("mt-0.5 grid size-7 shrink-0 place-items-center rounded-full", crit ? "bg-negative-soft text-negative" : "bg-warning-soft text-warning")}>
        <AlertTriangle className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium group-hover:text-accent">{title}</span>
        <span className="block text-xs text-muted">{message}</span>
        {meta && <span className="mt-1 block text-[11px] text-faint">{meta}</span>}
      </span>
    </Link>
  );
}

export function DiscrepancyCell({ value, own, other }: { value: number | null; own: number; other: number }) {
  const lvl = discrepancyLevel(value);
  return (
    <Tip content={`Наши показы: ${own.toLocaleString("ru")} · у сетки: ${other.toLocaleString("ru")}`}>
      <span className={cn("num", lvl === "warning" && "text-warning", lvl === "negative" && "text-negative")}>{fmtPercent(value)}{lvl !== "ok" && " ⚠"}</span>
    </Tip>
  );
}

const STATE = {
  FORECAST: { label: "прогноз", icon: null, cls: "border border-dashed border-border-strong text-muted" },
  INVOICED: { label: "выставлено", icon: FileText, cls: "" },
  CONFIRMED: { label: "подтверждено", icon: FileCheck2, cls: "" },
} as const;
export function MoneyStatus({ amount, state }: { amount: number; state: keyof typeof STATE }) {
  const s = STATE[state];
  const Icon = s.icon;
  return (
    <Tip content={s.label}>
      <span className={cn("num inline-flex items-center gap-1 rounded px-1", s.cls)}>{Icon && <Icon className="size-3.5 text-muted" />}{fmtMoney(amount)}</span>
    </Tip>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, [string, "neutral" | "accent" | "positive" | "negative" | "warning"]> = {
    ACTIVE: ["активен", "positive"], PAUSED: ["на паузе", "warning"], ARCHIVED: ["архив", "neutral"], DRAFT: ["черновик", "neutral"], ENDED: ["завершён", "neutral"],
    OPEN: ["открыт", "neutral"], INVOICED: ["выставлено", "accent"], PAID: ["оплачено", "positive"], PARTIAL: ["частично", "warning"],
    DISPUTED: ["спор", "negative"], WRITTEN_OFF: ["списано", "neutral"], ok: ["ok", "positive"], failed: ["ошибка", "negative"], partial: ["частично", "warning"], running: ["идёт", "accent"],
  };
  const [label, tone] = map[status] ?? [status, "neutral"];
  return <Badge tone={tone}>{label}</Badge>;
}
