"use client";
import { useState, useTransition } from "react";
import { ActionForm, FormField } from "@/components/forms/action-form";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { useToast } from "@/components/ui/toast";
import { fmtMoney } from "@/lib/format";
import { addRateAction, addSourceAction, applyImportAction, deleteRateAction, previewImportAction, revertImportAction, runJobAction } from "@/server/actions/settings";
import type { ImportPreview } from "@/server/services/costs";

type Opt = { id: string; label: string };

function useRun() {
  const [pending, start] = useTransition();
  const toast = useToast();
  const run = (fn: () => Promise<{ error?: string; message?: string }>) => start(async () => { const r = await fn(); r.error ? toast(r.error, "error") : toast(r.message ?? "Готово"); });
  return { pending, run };
}

export function AddRateButton({ sources, sites }: { sources: Opt[]; sites: Opt[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="primary" onClick={() => setOpen(true)}>Новая ставка</Button>
      <Sheet open={open} onOpenChange={setOpen} title="Новая ставка закупки" description="Ставка с той же областью закроет предыдущую датой «начало − 1 день». Частное важнее общего: сайт+гео > сайт > гео > все.">
        <ActionForm action={addRateAction} submit="Добавить" onDone={() => setOpen(false)} cancel={() => setOpen(false)}>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField name="sourceSlug" label="Источник"><Select name="sourceSlug">{sources.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</Select></FormField>
            <FormField name="rateModel" label="Модель"><Select name="rateModel" defaultValue="CPU">
              <option value="CPU">CPU — за уника</option><option value="CPM">CPM</option><option value="CPC">CPC</option><option value="FLAT">FLAT — в сутки</option></Select></FormField>
            <FormField name="siteId" label="Сайт"><Select name="siteId" defaultValue=""><option value="">Все сайты</option>{sites.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</Select></FormField>
            <FormField name="countryCode" label="Гео" hint="ISO-код, пусто — все"><Input name="countryCode" maxLength={2} className="font-mono uppercase" /></FormField>
            <FormField name="rate" label="Ставка, $"><Input name="rate" inputMode="decimal" required className="num" /></FormField>
            <div />
            <FormField name="validFrom" label="Действует с"><Input type="date" name="validFrom" required defaultValue={new Date().toISOString().slice(0, 10)} /></FormField>
            <FormField name="validTo" label="по" hint="Пусто — бессрочно"><Input type="date" name="validTo" /></FormField>
          </div>
        </ActionForm>
      </Sheet>
    </>
  );
}

export function DeleteRate({ id }: { id: string }) {
  const { pending, run } = useRun();
  return <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => deleteRateAction(id))}>Удалить</Button>;
}

export function RecalcForm() {
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  return (
    <ActionForm action={runJobAction} submit="Пересчитать расход" className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="job" value="derive" />
      <FormField name="from" label="С"><Input type="date" name="from" defaultValue={from} /></FormField>
      <FormField name="to" label="По"><Input type="date" name="to" defaultValue={today} /></FormField>
    </ActionForm>
  );
}

export function ImportCosts() {
  const [csv, setCsv] = useState("");
  const [name, setName] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [pending, start] = useTransition();
  const toast = useToast();
  const load = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    setCsv(text); setName(file.name);
    start(async () => { const r = await previewImportAction(text); "error" in r ? toast(r.error, "error") : setPreview(r); });
  };
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">CSV <code className="font-mono text-xs">date, domain, country, source, uniques, cost</code>. Импортированное всегда перекрывает расчётное по ставкам.</p>
      <input type="file" accept=".csv,text/csv" onChange={(e) => load(e.target.files?.[0])} className="text-sm file:mr-3 file:h-8 file:rounded-md file:border file:border-border file:bg-surface file:px-3 file:text-sm" />
      {preview && (
        <div className="rounded-lg border border-border bg-surface-2 p-4 text-sm">
          <div className="num grid gap-x-6 gap-y-1 sm:grid-cols-2">
            <span>Строк в файле: {preview.rows}</span><span>Распознано: {preview.recognised}</span>
            <span>Итоговая сумма: {fmtMoney(Number(preview.total))}</span><span>Перекроет расчётных строк: {preview.overrides}</span>
            <span>Период: {preview.from ?? "—"} — {preview.to ?? "—"}</span>
          </div>
          {preview.unknownDomains.length > 0 && <p className="mt-2 text-warning">Домены не найдены: {preview.unknownDomains.join(", ")}</p>}
          {preview.unknownSources.length > 0 && <p className="mt-1 text-warning">Неизвестные источники: {preview.unknownSources.join(", ")}</p>}
          {preview.unknownCountries.length > 0 && <p className="mt-1 text-warning">Гео не смаплено (уйдёт в XX): {preview.unknownCountries.join(", ")}</p>}
          {preview.errors.length > 0 && <p className="mt-1 text-negative">Ошибки: {preview.errors.slice(0, 5).map((e) => `строка ${e.line}: ${e.reason}`).join("; ")}{preview.errors.length > 5 && "…"}</p>}
          <div className="mt-3 flex gap-2">
            <Button variant="primary" size="sm" disabled={pending || !preview.recognised}
              onClick={() => start(async () => { const r = await applyImportAction(csv, name); if (r.error) toast(r.error, "error"); else { toast(r.message ?? "Импортировано"); setPreview(null); setCsv(""); } })}>
              Импортировать {preview.recognised} строк</Button>
            <Button size="sm" onClick={() => setPreview(null)}>Отмена</Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function RevertImport({ id }: { id: string }) {
  const { pending, run } = useRun();
  return <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => revertImportAction(id))}>Откатить импорт</Button>;
}

export function AddSource() {
  return (
    <ActionForm action={addSourceAction} submit="Добавить источник" className="flex flex-wrap items-end gap-3">
      <FormField name="slug" label="Слаг"><Input name="slug" required className="w-40 font-mono" /></FormField>
      <FormField name="title" label="Название"><Input name="title" required className="w-48" /></FormField>
    </ActionForm>
  );
}
