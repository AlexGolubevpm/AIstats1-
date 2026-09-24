import { DataTable } from "@/components/data/data-table";
import { PageHeader } from "@/components/layout/page-header";
import { SITE_COLS } from "@/components/pages/columns";
import { Section } from "@/components/ui/card";
import { periodFromParams } from "@/lib/period";
import { db } from "@/server/db";
import { sitesTable } from "@/server/queries/reports";

export default async function Sites({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const p = periodFromParams(await searchParams, "7d");
  const [rows, links] = await Promise.all([sitesTable(p), db.bundleSite.findMany({ include: { bundle: true } })]);
  const bundlesOf = (id: string) => links.filter((l) => l.siteId === id).map((l) => ({ label: l.bundle.title, tone: "neutral" as const }));
  return (
    <>
      <PageHeader title="Сайты" sub={`${rows.length} активных и на паузе`} period={p} />
      <Section title="Все сайты">
        <DataTable id="s" exportName="sites" defaultSort={{ id: "margin", dir: "desc" }}
          columns={[...SITE_COLS.slice(0, 1), { id: "status", header: "Статус", kind: "text" }, ...SITE_COLS.slice(1)]}
          rows={rows.map((s) => ({ ...s, status: s.status === "ACTIVE" ? "активен" : "пауза", _key: s.id, _href: `/sites/${s.domain}`, _badges: { domain: bundlesOf(s.id) } }))}
          filters={[{ id: "loss", label: "Только убыточные", column: "margin", op: "lt", value: 0 }]} />
      </Section>
    </>
  );
}
