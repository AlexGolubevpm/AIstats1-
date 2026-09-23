import Link from "next/link";
import { DataTable } from "@/components/data/data-table";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Section } from "@/components/ui/card";
import { periodFromParams } from "@/lib/period";
import { bundlesTable, overlappingSites } from "@/server/queries/reports";

export default async function Bundles({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const p = periodFromParams(await searchParams, "7d");
  const [rows, overlap] = await Promise.all([bundlesTable(p), overlappingSites()]);
  return (
    <>
      <PageHeader title="Бандлы" period={p} actions={<Button asChild size="sm"><Link href="/settings/bundles">Создать бандл</Link></Button>} />
      <Section title="Все бандлы" sub={overlap ? `${overlap} сайта входят в несколько бандлов: сумма по бандлам больше итога сети.` : undefined}>
        <DataTable id="b" exportName="bundles" defaultSort={{ id: "margin", dir: "desc" }}
          columns={[{ id: "title", header: "Бандл", kind: "text" }, { id: "sites", header: "Сайтов", kind: "int" }, { id: "uniques", header: "Уники", kind: "int" },
            { id: "revenue", header: "Выручка", kind: "money" }, { id: "cost", header: "Расход", kind: "money" }, { id: "margin", header: "Маржа", kind: "money", heat: "sign" },
            { id: "romi", header: "ROMI", kind: "romi", heat: "vsMean" }, { id: "rpm", header: "RPM", kind: "money" }]}
          rows={rows.map((b) => ({ ...b, _key: b.id, _href: `/bundles/${b.slug}` }))} />
      </Section>
    </>
  );
}
