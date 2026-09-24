import { Activity, DollarSign, Gauge, Layers3, PiggyBank, TrendingUp, Users, Wallet } from "lucide-react";
import { delta } from "@/lib/metrics";
import { sparkOf, type KpiSet } from "@/server/queries/common";
import { KpiCard } from "./kpi-card";

export type KpiKey = "revenue" | "cost" | "margin" | "romi" | "uniques" | "rpm" | "depth" | "confirmed";

/** Standard KPI row: delta vs the previous equal period, 14-day sparkline. ROMI is wider. */
export function KpiRow({ k, keys, partial }: { k: KpiSet; keys: KpiKey[]; partial?: string }) {
  const cards: Record<KpiKey, React.ReactNode> = {
    revenue: <KpiCard key="revenue" label="Выручка" value={k.cur.revenue} format="money" icon={DollarSign} color="#3B82F6"
      delta={delta(k.cur.revenue, k.prev.revenue, "percent")} spark={sparkOf(k, (t) => t.revenue)} />,
    cost: <KpiCard key="cost" label="Расход" value={k.cur.cost} format="money" icon={Wallet} color="#F59E0B" tone="inverse"
      delta={delta(k.cur.cost, k.prev.cost, "percent")} spark={sparkOf(k, (t) => t.cost)} warn={partial} />,
    margin: <KpiCard key="margin" label="Маржа" value={k.cur.margin} format="money" icon={PiggyBank} color="#8B5CF6" negativeFrame={k.cur.margin < 0}
      delta={delta(k.cur.margin, k.prev.margin, "percent")} spark={sparkOf(k, (t) => t.margin)} />,
    romi: <KpiCard key="romi" label="ROMI" value={k.cur.romi} format="percent" icon={TrendingUp} color="#16A34A" emphasis deltaMode="pp"
      delta={delta(k.cur.romi, k.prev.romi, "pp")} spark={sparkOf(k, (t) => t.romi)} negativeFrame={(k.cur.romi ?? 0) < 0} warn={partial} />,
    uniques: <KpiCard key="uniques" label="Уники" value={k.cur.uniques} format="compact" icon={Users} color="#06B6D4"
      delta={delta(k.cur.uniques, k.prev.uniques, "percent")} spark={sparkOf(k, (t) => t.uniques)} sub="сумма дневных" />,
    rpm: <KpiCard key="rpm" label="RPM на уника" value={k.cur.rpm} format="moneyPrecise" icon={Gauge} color="#EC4899"
      delta={delta(k.cur.rpm, k.prev.rpm, "percent")} spark={sparkOf(k, (t) => t.rpm)} />,
    depth: <KpiCard key="depth" label="Глубина" value={k.cur.depth} format="decimal" icon={Layers3} color="#64748B"
      delta={delta(k.cur.depth, k.prev.depth, "percent")} spark={sparkOf(k, (t) => t.depth)} sub="просмотров на уника" />,
    confirmed: <KpiCard key="confirmed" label="Подтверждено" value={k.cur.revenueConfirmed} format="money" icon={Activity} color="#16A34A" tone="neutral" />,
  };
  const cols = keys.length + (keys.includes("romi") ? 1 : 0);
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-4 xl:[grid-template-columns:repeat(var(--c),minmax(0,1fr))]" style={{ ["--c" as string]: cols }}>
      {keys.map((key) => cards[key])}
    </div>
  );
}
