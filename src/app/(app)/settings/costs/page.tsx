import { Section } from "@/components/ui/card";
import { fmtDate, fmtMoney } from "@/lib/format";
import { db } from "@/server/db";
import { sitesWithoutRates } from "@/server/services/settings";
import { AddRateButton, AddSource, DeleteRate, ImportCosts, RecalcForm, RevertImport } from "./client";

const MODEL: Record<string, string> = { CPU: "за уника", CPM: "CPM", CPC: "CPC", FLAT: "флэт/сутки" };

export default async function CostsSettings() {
  const [rates, sources, sites, batches, noRate] = await Promise.all([
    db.costRate.findMany({ orderBy: [{ sourceSlug: "asc" }, { validFrom: "desc" }] }),
    db.costSource.findMany({ orderBy: { title: "asc" } }),
    db.site.findMany({ where: { status: { not: "ARCHIVED" } }, orderBy: { domain: "asc" } }),
    db.importBatch.findMany({ where: { kind: "costs" }, orderBy: { createdAt: "desc" }, take: 20 }),
    sitesWithoutRates(db),
  ]);
  const siteName = new Map(sites.map((s) => [s.id, s.domain]));
  const srcName = new Map(sources.map((s) => [s.slug, s.title]));
  const today = new Date().toISOString().slice(0, 10);
  return (
    <>
      <Section title="Ставки" sub="Расход по ставкам считается каждую ночь; импорт фактического расхода всегда важнее"
        actions={<AddRateButton sources={sources.map((s) => ({ id: s.slug, label: s.title }))} sites={sites.map((s) => ({ id: s.id, label: s.domain }))} />}>
        {noRate.length > 0 && <p className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning">Нет применимой ставки у активных сайтов с трафиком: {noRate.join(", ")}</p>}
        <div className="-mx-5 overflow-x-auto">
          <table className="num w-full text-[13px]">
            <thead><tr className="border-b border-border text-xs text-muted">{["Источник", "Сайт", "Гео", "Модель", "Ставка", "Действует с", "по", ""].map((h, i) =>
              <th key={i} className={`h-9 px-3 font-medium ${i === 4 ? "text-right" : "text-left"} ${i === 0 ? "pl-5" : ""}`}>{h}</th>)}</tr></thead>
            <tbody>{rates.map((r) => {
              const closed = r.validTo && r.validTo.toISOString().slice(0, 10) < today;
              return (
                <tr key={r.id} className={`h-10 border-b border-border/60 ${closed ? "text-faint" : ""}`}>
                  <td className="pl-5">{srcName.get(r.sourceSlug) ?? r.sourceSlug}</td>
                  <td className="px-3 font-mono text-xs">{r.siteId ? siteName.get(r.siteId) ?? "архив" : "все"}</td>
                  <td className="px-3 font-mono text-xs">{r.countryCode ?? "все"}</td>
                  <td className="px-3">{MODEL[r.rateModel]}</td>
                  <td className="px-3 text-right">${r.rate.toString()}</td>
                  <td className="px-3">{fmtDate(r.validFrom)}</td>
                  <td className="px-3">{r.validTo ? fmtDate(r.validTo) : "—"}</td>
                  <td className="pr-5 text-right"><DeleteRate id={r.id} /></td>
                </tr>
              );
            })}
            {rates.length === 0 && <tr><td colSpan={8} className="py-8 text-center text-sm text-muted">Ставок нет — расход не считается</td></tr>}</tbody>
          </table>
        </div>
        <div className="border-t border-border pt-4"><RecalcForm /></div>
      </Section>
      <Section title="Импорт фактического расхода"><ImportCosts /></Section>
      <Section title="История импортов">
        {batches.length === 0 ? <p className="text-sm text-muted">Импортов не было</p> : (
          <ul className="divide-y divide-border text-[13px]">{batches.map((b) => (
            <li key={b.id} className="num flex flex-wrap items-center gap-4 py-2">
              <span className="w-32 text-muted">{fmtDate(b.createdAt)}</span><span className="flex-1 font-mono text-xs">{b.fileName}</span>
              <span>{b.rows} строк</span><span>{fmtMoney(Number(b.total))}</span>
              {b.revertedAt ? <span className="text-muted">откатан {fmtDate(b.revertedAt)}</span> : <RevertImport id={b.id} />}
            </li>
          ))}</ul>
        )}
      </Section>
      <Section title="Источники закупки" sub="Валюта всегда USD">
        <ul className="flex flex-wrap gap-2 text-sm">{sources.map((s) => <li key={s.slug} className="rounded-full border border-border px-3 py-1">{s.title} <span className="font-mono text-xs text-faint">{s.slug}</span></li>)}</ul>
        <AddSource />
      </Section>
    </>
  );
}
