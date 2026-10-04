"use client";
import { useState, useTransition } from "react";
import { ActionForm, FormField } from "@/components/forms/action-form";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Confirm } from "@/components/ui/sheet";
import { useToast } from "@/components/ui/toast";
import { cancelBackfillAction, demoAction, mapAliasAction, resumeAsgAction, runJobAction, startBackfillAction, testAsgAction } from "@/server/actions/settings";

function useRun() {
  const [pending, start] = useTransition();
  const toast = useToast();
  return { pending, run: (fn: () => Promise<{ error?: string; message?: string }>) => start(async () => { const r = await fn(); r.error ? toast(r.error, "error") : toast(r.message ?? "Готово"); }) };
}

export function TestAsg() {
  const { pending, run } = useRun();
  return <Button size="sm" disabled={pending} onClick={() => run(testAsgAction)}>{pending ? "Проверяем…" : "Проверить соединение"}</Button>;
}

export function ResumeAsg() {
  const { pending, run } = useRun();
  return <Button size="sm" disabled={pending} onClick={() => run(resumeAsgAction)}>Снять паузу</Button>;
}

export function RunJobForm({ jobs, sites }: { jobs: { id: string; label: string }[]; sites: { id: string; domain: string }[] }) {
  const [job, setJob] = useState(jobs[0]?.id ?? "");
  return (
    <ActionForm action={runJobAction} submit="Поставить в очередь" className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_auto_auto_1fr] [&>div:last-child]:col-span-full">
      <FormField name="job" label="Джоб"><Select name="job" value={job} onChange={(e) => setJob(e.target.value)}>{jobs.map((j) => <option key={j.id} value={j.id}>{j.label}</option>)}</Select></FormField>
      <FormField name="from" label="С"><Input type="date" name="from" /></FormField>
      <FormField name="to" label="По"><Input type="date" name="to" /></FormField>
      <FormField name="siteId" label="Сайт (опционально)"><Select name="siteId" defaultValue=""><option value="">Все</option>{sites.map((s) => <option key={s.id} value={s.id}>{s.domain}</option>)}</Select></FormField>
      {job === "asg:sites" && (
        <FormField name="confirm" label="Бэкфилл" className="sm:col-span-2 lg:col-span-4" hint="Каждый сайт × день = 4 запроса к AdSpyglass (страны, сетки, устройства, источники) плюс 2 на день. Для окна длиннее пары дней используйте блок «Бэкфилл AdSpyglass» — он сам делит работу по суткам.">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="confirm" value="1" /> Понимаю, сколько запросов уйдёт, и что бэкфилл может занять несколько дней</label>
        </FormField>
      )}
    </ActionForm>
  );
}

export function AliasRow({ source, raw, rows, countries }: { source: string; raw: string; rows: number; countries: { code: string; name: string }[] }) {
  return (
    <ActionForm action={mapAliasAction} submit="Сопоставить" className="flex flex-wrap items-end gap-3 border-b border-border/60 py-2">
      <input type="hidden" name="source" value={source} /><input type="hidden" name="raw" value={raw} />
      <div className="min-w-48 flex-1 text-sm"><span className="font-mono">{raw}</span><div className="text-xs text-muted">{source} · {rows} строк ушло в XX</div></div>
      <FormField name="countryCode" label="ISO-код">
        <Input name="countryCode" list="countries" required maxLength={2} className="w-24 font-mono uppercase" />
      </FormField>
      <datalist id="countries">{countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</datalist>
    </ActionForm>
  );
}

export function ReprocessButton() {
  const { pending, run } = useRun();
  const f = new FormData();
  f.set("job", "geo:reprocess");
  return <Button size="sm" variant="primary" disabled={pending} onClick={() => run(() => runJobAction({}, f))}>Пересчитать из сырья</Button>;
}

export function DemoButtons({ demo, hasData }: { demo: boolean; hasData: boolean }) {
  const { pending, run } = useRun();
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="flex flex-wrap gap-2">
      {!hasData && <Button size="sm" disabled={pending} onClick={() => run(() => demoAction("load"))}>{pending ? "Загружаем…" : "Загрузить демо-данные"}</Button>}
      {demo && <Button size="sm" variant="destructive" disabled={pending} onClick={() => setConfirm(true)}>Удалить демо-данные</Button>}
      {hasData && !demo && <p className="text-sm text-muted">В базе настоящие данные — демо недоступно.</p>}
      <Confirm open={confirm} onOpenChange={setConfirm} title="Удалить демо-данные?" destructive confirmLabel="Удалить"
        body="Будут удалены все сайты, бандлы, факты и дилы. Справочники (страны, сетки, источники) останутся." onConfirm={() => run(() => demoAction("clear"))} />
    </div>
  );
}

export interface BackfillView { from: string; to: string; mode: "full" | "totals"; siteDomain: string | null; total: number; done: number; failed: number; pending: number; updatedAt: string; lastStop: string | null; cancelled: boolean }
type Win = { from: string; to: string };
const MODE_LABEL = { full: "все разрезы", totals: "только итоги по сайтам" } as const;

/** «Бэкфилл AdSpyglass»: mode + window form, progress of the running one, cancel. */
export function BackfillBlock({ state, sites, defaults, perNight }: { state: BackfillView | null; sites: { id: string; domain: string }[]; defaults: { full: Win; totals: Win }; perNight: { full: number; totals: number } }) {
  const { pending, run } = useRun();
  const running = state && !state.cancelled && state.pending > 0;
  const [mode, setMode] = useState<"full" | "totals">(state && !state.cancelled ? state.mode : "full");
  const [win, setWin] = useState<Win>(state && !state.cancelled ? { from: state.from, to: state.to } : defaults.full);
  const pick = (m: "full" | "totals") => { setMode(m); setWin(defaults[m]); };
  return (
    <div className="flex flex-col gap-4">
      {state && !state.cancelled && (
        <div className="rounded-lg border border-border p-3 text-sm" data-testid="backfill-progress">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-medium">{state.from} — {state.to}{state.siteDomain ? ` · ${state.siteDomain}` : ""}</span>
            <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted">{MODE_LABEL[state.mode]}</span>
            <span className="num">готово {state.done} из {state.total} дней</span>
            {state.failed > 0 && <span className="text-negative">ошибок: {state.failed}</span>}
            {running && <span className="text-muted">осталось ≈ {Math.ceil(state.pending / Math.max(1, perNight[state.mode]))} сут. · порции каждые 30 минут, пока хватает бюджета</span>}
            {!running && <span className="text-positive">завершён</span>}
          </div>
          <div className="mt-2 h-1.5 rounded-full bg-surface-hover"><div className="h-full rounded-full bg-accent" style={{ width: `${state.total ? (state.done / state.total) * 100 : 0}%` }} /></div>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted">
            <span>обновлено {state.updatedAt.slice(11, 16)} UTC</span>
            {state.lastStop && <span>· остановлен: {state.lastStop}</span>}
            {running && <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(cancelBackfillAction)}>Отменить</Button>}
          </div>
        </div>
      )}
      <ActionForm action={startBackfillAction} submit={running ? "Изменить окно" : "Запустить бэкфилл"} className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <FormField name="mode" label="Что грузить">
          <Select name="mode" value={mode} onChange={(e) => pick(e.target.value as "full" | "totals")}>
            <option value="full">Все разрезы (2 + 4 × сайтов запросов в день)</option>
            <option value="totals">Только итоги по сайтам (1 запрос в день)</option>
          </Select>
        </FormField>
        <FormField name="from" label="С"><Input type="date" name="from" value={win.from} onChange={(e) => setWin({ ...win, from: e.target.value })} required /></FormField>
        <FormField name="to" label="По" hint={`≈ ${perNight[mode]} дн. в сутки при текущем бюджете и резерве`}><Input type="date" name="to" value={win.to} onChange={(e) => setWin({ ...win, to: e.target.value })} required /></FormField>
        <FormField name="siteId" label="Сайт (опционально)"><Select name="siteId" defaultValue=""><option value="">Все</option>{sites.map((s) => <option key={s.id} value={s.id}>{s.domain}</option>)}</Select></FormField>
      </ActionForm>
    </div>
  );
}
