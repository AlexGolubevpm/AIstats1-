import { Activity, DollarSign, Gauge, Layers3, PiggyBank, Scale, TrendingUp, Users, Wallet } from "lucide-react";
import { delta } from "@/lib/metrics";
import type { KpiSet } from "@/server/queries/common";
import { KpiCard, type KpiProps } from "./kpi-card";

export type KpiKey = "revenue" | "cost" | "margin" | "romi" | "uniques" | "rpm" | "depth" | "confirmed" | "revPer1k";
export type KpiCompare = Partial<Record<KpiKey, KpiProps["compare"]>>;

/** Standard KPI row: delta vs the previous equal period (no sparklines: a line without an axis says nothing). ROMI is wider. `compare` adds a peers line per card (site page). */
export function KpiRow({ k, keys, partial, compare = {} }: { k: KpiSet; keys: KpiKey[]; partial?: string; compare?: KpiCompare }) {
  const cards: Record<KpiKey, React.ReactNode> = {
    revenue: <KpiCard key="revenue" label="Выручка" value={k.cur.revenue} format="money" icon={DollarSign} color="#3B82F6"
      delta={delta(k.cur.revenue, k.prev.revenue, "percent")} />,
    cost: <KpiCard key="cost" label="Расход на трафик" value={k.cur.cost} format="money" icon={Wallet} color="#F43F5E" tone="inverse"
      delta={delta(k.cur.cost, k.prev.cost, "percent")} warn={partial} />,
    margin: <KpiCard key="margin" label="Маржа" value={k.cur.margin} format="money" icon={PiggyBank} color="#8B5CF6" negativeFrame={k.cur.margin < 0}
      delta={delta(k.cur.margin, k.prev.margin, "percent")} sub="до опер. расходов" />,
    romi: <KpiCard key="romi" label="ROMI" value={k.cur.romi} format="percent" icon={TrendingUp} color="#16A34A" emphasis deltaMode="pp"
      delta={delta(k.cur.romi, k.prev.romi, "pp")} negativeFrame={(k.cur.romi ?? 0) < 0} warn={partial} compare={compare.romi} />,
    uniques: <KpiCard key="uniques" label="Уники" value={k.cur.uniques} format="compact" icon={Users} color="#06B6D4"
      delta={delta(k.cur.uniques, k.prev.uniques, "percent")} sub="сумма дневных" />,
    rpm: <KpiCard key="rpm" label="RPM на уника" value={k.cur.rpm} format="moneyPrecise" icon={Gauge} color="#EC4899"
      delta={delta(k.cur.rpm, k.prev.rpm, "percent")} compare={compare.rpm} />,
    depth: <KpiCard key="depth" label="Глубина" value={k.cur.depth} format="decimal" icon={Layers3} color="#64748B"
      delta={delta(k.cur.depth, k.prev.depth, "percent")} sub="просмотров на уника" compare={compare.depth} />,
    revPer1k: <KpiCard key="revPer1k" label="Rev / 1000 loads" value={k.cur.revPer1k} format="moneyPrecise" icon={Scale} color="#0EA5E9"
      delta={delta(k.cur.revPer1k, k.prev.revPer1k, "percent")} sub="сравнимо между сайтами" compare={compare.revPer1k} />,
    confirmed: <KpiCard key="confirmed" label="Подтверждено" value={k.cur.revenueConfirmed} format="money" icon={Activity} color="#16A34A" tone="neutral" />,
  };
  const cols = keys.length + (keys.includes("romi") ? 1 : 0);
  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 min-[1700px]:[grid-template-columns:repeat(var(--c),minmax(0,1fr))]" style={{ ["--c" as string]: cols }}>
      {keys.map((key) => cards[key])}
    </div>
  );
}
