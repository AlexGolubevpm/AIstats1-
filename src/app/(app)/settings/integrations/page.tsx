import { StatusBadge } from "@/components/data/misc";
import { Badge } from "@/components/ui/badge";
import { Section } from "@/components/ui/card";
import { fmtAgo, fmtDate, fmtInt } from "@/lib/format";
import { config } from "@/server/config";
import { db } from "@/server/db";
import { asgPause, asgRequestsToday } from "@/server/ingest/run";
import { SCHEDULES } from "@/server/jobs/handlers";
import { isDemo } from "@/server/seed/demo";
import { AliasRow, DemoButtons, ReprocessButton, ResumeAsg, RunJobForm, TestAsg } from "./client";

const JOB_LABEL: Record<string, string> = {
  "asg:totals": "AdSpyglass: итоги по сайтам (1 запрос в день окна)", "asg:sites": "AdSpyglass: гео и зоны по сайтам (ночной)",
  metrika: "Метрика: трафик", derive: "Расход → прогноз дилов → алерты", "geo:reprocess": "Пересчитать гео из сырья (без запросов к API)",
};
const CRON: Record<string, string> = { "5 * * * *": "каждый час в :05", "0 4 * * *": "ежедневно 04:00 UTC", "15 * * * *": "каждый час в :15", "45 4 * * *": "ежедневно 04:45 UTC" };
const tail = (s: string) => (s ? `задан · …${s.slice(-4)}` : "не задан");

export default async function Integrations() {
  const cfg = config();
  const since = new Date(Date.now() - 7 * 86_400_000);
  const [pause, used, runs, unresolved, countries, sites, demo, hasData] = await Promise.all([
    asgPause(db), asgRequestsToday(db),
    db.ingestRun.findMany({ where: { startedAt: { gte: since } }, orderBy: { startedAt: "desc" }, take: 100 }),
    db.unresolvedAlias.findMany({ orderBy: { rows: "desc" } }),
    db.country.findMany({ where: { tier: { gt: 0 } }, orderBy: { code: "asc" } }),
    db.site.findMany({ where: { status: { not: "ARCHIVED" } }, orderBy: { domain: "asc" } }),
    isDemo(db), db.site.count().then((n) => n > 0),
  ]);
  const lastBy = (job: string) => runs.find((r) => r.job === job);
  const dur = (a: Date, b: Date | null) => (b ? `${Math.max(1, Math.round((b.getTime() - a.getTime()) / 1000))} с` : "идёт");
  const conn = [
    { name: "AdSpyglass (ADOK)", ok: cfg.asg.configured, detail: `email: ${cfg.asg.email ? "задан" : "не задан"} · токен: ${tail(cfg.asg.token)}`, action: cfg.asg.configured ? <TestAsg /> : null },
    { name: "Яндекс Метрика", ok: cfg.metrika.configured, detail: `OAuth-токен: ${tail(cfg.metrika.token)}`, action: null },
    { name: "S3 для сырья", ok: cfg.s3Configured, detail: cfg.s3Configured ? "S3" : `локальная папка ${process.env.RAW_DIR ?? "/data/raw"}`, action: null },
  ];
  return (
    <>
      <Section title="Подключения" sub="Значения хранятся в .env на сервере; здесь только статус. Менять через UI нельзя — секреты не лежат в базе">
        <ul className="-mx-5 divide-y divide-border">{conn.map((c) => (
          <li key={c.name} className="flex flex-wrap items-center gap-3 px-5 py-3">
            <span className={`size-2 rounded-full ${c.ok ? "bg-positive" : "bg-border-strong"}`} />
            <div className="min-w-0 flex-1"><div className="text-sm font-medium">{c.name}</div><div className="text-xs text-muted">{c.detail}</div></div>
            {c.action}
          </li>
        ))}</ul>
      </Section>

      <Section title="Лимиты AdSpyglass" sub="ADOK блокирует частые запросы: один запрос за раз, пауза между запросами, дневной бюджет">
        <div className="num grid gap-4 text-sm sm:grid-cols-3">
          <div><div className="text-xs text-muted">Запросов сегодня (UTC)</div><div className="text-lg font-semibold">{used} / {cfg.asg.dailyBudget}</div>
            <div className="mt-1 h-1.5 rounded-full bg-surface-hover"><div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, (used / cfg.asg.dailyBudget) * 100)}%` }} /></div></div>
          <div><div className="text-xs text-muted">Интервал между запросами</div><div className="text-lg font-semibold">{cfg.asg.minIntervalMs / 1000} с</div></div>
          <div><div className="text-xs text-muted">Состояние</div>
            {pause ? <div className="flex flex-col items-start gap-1"><Badge tone="negative">пауза до {pause.until.slice(11, 16)} UTC</Badge><span className="text-xs text-muted">{pause.reason}</span><ResumeAsg /></div>
              : <Badge tone="positive">работает</Badge>}</div>
        </div>
      </Section>

      <Section title="Ингест">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">{SCHEDULES.map((s) => {
          const r = lastBy(s.name);
          return (
            <div key={s.name} className="rounded-lg border border-border p-3 text-sm">
              <div className="font-mono text-xs text-muted">{s.name}</div>
              <div className="mt-0.5 font-medium">{JOB_LABEL[s.name]}</div>
              <div className="mt-2 text-xs text-muted">{CRON[s.pattern] ?? s.pattern}</div>
              <div className="mt-1 flex items-center gap-2 text-xs">{r ? <><StatusBadge status={r.status} /><span className="text-muted">{fmtAgo(r.startedAt)} · {fmtInt(r.rowsUpsert)} строк · {dur(r.startedAt, r.finishedAt)}</span></> : <span className="text-faint">ещё не запускался</span>}</div>
            </div>
          );
        })}</div>
        <div className="border-t border-border pt-4">
          <h3 className="mb-2 text-sm font-medium">Ручной перезапуск и бэкфилл</h3>
          <RunJobForm jobs={Object.entries(JOB_LABEL).map(([id, label]) => ({ id, label }))} sites={sites.map((s) => ({ id: s.id, domain: s.domain }))} />
        </div>
      </Section>

      <Section title="Лог за 7 дней">
        {runs.length === 0 ? <p className="text-sm text-muted">Запусков не было</p> : (
          <div className="-mx-5 overflow-x-auto">
            <table className="num w-full text-[13px]">
              <thead><tr className="border-b border-border text-xs text-muted">{["Когда", "Джоб", "Окно", "Статус", "Строк", "Запросов", "Длительность", "Ошибка"].map((h, i) =>
                <th key={h} className={`h-9 px-3 font-medium ${i === 0 ? "pl-5" : ""} ${[4, 5].includes(i) ? "text-right" : "text-left"}`}>{h}</th>)}</tr></thead>
              <tbody>{runs.map((r) => (
                <tr key={r.id} className="border-b border-border/60 align-top">
                  <td className="py-2 pl-5 whitespace-nowrap text-muted">{fmtAgo(r.startedAt)}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.job}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{fmtDate(r.dateFrom)} — {fmtDate(r.dateTo)}</td>
                  <td className="px-3 py-2"><StatusBadge status={r.status} /></td>
                  <td className="px-3 py-2 text-right">{fmtInt(r.rowsUpsert)}</td>
                  <td className="px-3 py-2 text-right">{fmtInt(r.requests)}</td>
                  <td className="px-3 py-2">{dur(r.startedAt, r.finishedAt)}</td>
                  <td className="max-w-md px-3 py-2 pr-5">{r.error ? <details><summary className="cursor-pointer truncate text-negative">{r.error.slice(0, 80)}</summary><pre className="mt-1 text-xs whitespace-pre-wrap text-muted">{r.error}</pre></details> : <span className="text-faint">—</span>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Section>

      <section id="geo" className="scroll-mt-6">
        <Section title="Нераспознанные гео" sub="После сопоставления «Пересчитать» перезапишет строки из сохранённого сырья, без повторного обхода API"
          actions={unresolved.length === 0 ? undefined : <ReprocessButton />}>
          {unresolved.length === 0 ? <p className="text-sm text-muted">Все страны распознаны.</p> : unresolved.map((u) => (
            <AliasRow key={`${u.source}|${u.raw}`} source={u.source} raw={u.raw} rows={u.rows} countries={countries.map((c) => ({ code: c.code, name: c.nameRu }))} />
          ))}
        </Section>
      </section>

      <Section title="Демо-данные" sub="Сгенерированная сеть на 60 дней, чтобы посмотреть интерфейс до подключения источников">
        <DemoButtons demo={demo} hasData={hasData} />
      </Section>
    </>
  );
}
