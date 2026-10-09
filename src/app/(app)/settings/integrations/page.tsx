import { TableScroll } from "@/components/data/table-scroll";
import { StatusBadge } from "@/components/data/misc";
import { Badge } from "@/components/ui/badge";
import { Section } from "@/components/ui/card";
import { fmtAgo, fmtDate, fmtInt } from "@/lib/format";
import { config } from "@/server/config";
import { db } from "@/server/db";
import { asgBudget, asgPause, asgRequestsToday } from "@/server/ingest/run";
import { SCHEDULES } from "@/server/jobs/handlers";
import { daysBetween, defaultWindow, readBackfill, requestsPerDay } from "@/server/jobs/backfill";
import { CUTS, planCost, readPlan } from "@/server/ingest/adspyglass/plan";
import { isDemo } from "@/server/seed/demo";
import { authorizeUrl } from "@/server/ingest/metrika/oauth";
import { metrikaCallbackUrl, metrikaStatus } from "@/server/services/metrika-connection";
import { withBase } from "@/lib/base-path";
import { AliasRow, BackfillBlock, BudgetForm, CutsPlanner, DemoButtons, MetrikaBlock, ReprocessButton, ResumeAsg, RunJobForm, TestAsg } from "./client";

const JOB_LABEL: Record<string, string> = {
  "asg:sites": "AdSpyglass: разрезы по сайтам из плана ниже (страны, сетки, устройства, источники, форматы), зоны + расход (ночной)",
  "asg:totals": "AdSpyglass: только итоги по сайтам (1 запрос в день окна, без разрезов)",
  "asg:backfill": "AdSpyglass: бэкфилл прошлых дней порциями под бюджет (окно — в блоке ниже)",
  metrika: "Метрика: трафик", derive: "Расход → прогноз дилов → алерты", "geo:reprocess": "Пересчитать гео из сырья (без запросов к API)",
};
const CRON: Record<string, string> = { "5 * * * *": "каждый час в :05", "0 4 * * *": "ежедневно 04:00 UTC", "*/30 * * * *": "каждые 30 минут, если есть что догружать", "15 * * * *": "каждый час в :15", "45 4 * * *": "ежедневно 04:45 UTC" };
const tail = (s: string) => (s ? `задан · …${s.slice(-4)}` : "не задан");

export default async function Integrations({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const cfg = config();
  const since = new Date(Date.now() - 7 * 86_400_000);
  const [[xx], pause, used, runs, unresolved, countries, sites, demo, hasData] = await Promise.all([
    db.$queryRaw<{ xx: number; all: number }[]>`SELECT count(*) FILTER (WHERE "countryCode" = 'XX')::int xx, count(*) FILTER (WHERE "countryCode" <> 'ZZ')::int "all"
      FROM "FactRevenueGeo" WHERE date >= ${since}`,
    asgPause(db), asgRequestsToday(db),
    db.ingestRun.findMany({ where: { startedAt: { gte: since } }, orderBy: { startedAt: "desc" }, take: 100 }),
    db.unresolvedAlias.findMany({ orderBy: { rows: "desc" } }),
    db.country.findMany({ where: { tier: { gt: 0 } }, orderBy: { code: "asc" } }),
    db.site.findMany({ where: { status: { not: "ARCHIVED" } }, orderBy: { domain: "asc" } }),
    isDemo(db), db.site.count().then((n) => n > 0),
  ]);
  const metrika = await metrikaStatus(db, cfg);
  const metrikaDetail = metrika.kind === "oauth" ? `подключена по OAuth${metrika.expiresAt ? ` · токен до ${fmtDate(metrika.expiresAt)}` : ""} · приложение …${metrika.clientId.slice(-4)}`
    : metrika.kind === "app" ? `приложение …${metrika.clientId.slice(-4)} сохранено, токена ещё нет — получите код ниже`
    : metrika.kind === "env" ? `токен из .env: ${tail(cfg.metrika.token)}`
    : metrika.kind === "broken" ? metrika.error : "не подключена — блок «Яндекс Метрика» ниже";
  const [backfill, plan, budget] = await Promise.all([readBackfill(db), readPlan(db), asgBudget(db, cfg.asg.dailyBudget)]);
  const today = new Date().toISOString().slice(0, 10);
  const asgSites = sites.filter((s) => s.status === "ACTIVE" && s.adsgSiteId).length;
  const nSites = backfill?.siteId ? 1 : Math.max(1, asgSites);
  // What the plan spends a day over all sites; the backfill gets what is left.
  const cost = planCost(plan, Math.max(1, asgSites), budget.limit);
  const perNight = { full: Math.max(0, Math.floor(cost.backfill / requestsPerDay(nSites, "full", plan))), totals: Math.max(0, Math.floor(cost.backfill / requestsPerDay(nSites, "totals", plan))) };
  const backfillView = backfill ? { from: backfill.from, to: backfill.to, mode: backfill.mode ?? "full", siteDomain: backfill.siteId ? sites.find((s) => s.id === backfill.siteId)?.domain ?? null : null,
    total: daysBetween(backfill.from, backfill.to).length, done: backfill.done.length, failed: backfill.failed.length, pending: backfill.pending.length,
    updatedAt: backfill.updatedAt, lastStop: backfill.lastStop ?? null, cancelled: Boolean(backfill.cancelled) } : null;
  const lastBy = (job: string) => runs.find((r) => r.job === job);
  const dur = (a: Date, b: Date | null) => (b ? `${Math.max(1, Math.round((b.getTime() - a.getTime()) / 1000))} с` : "идёт");
  const conn = [
    { name: "AdSpyglass (ADOK)", ok: cfg.asg.configured, detail: `email: ${cfg.asg.email ? "задан" : "не задан"} · токен: ${tail(cfg.asg.token)}`, action: cfg.asg.configured ? <TestAsg /> : null },
    { name: "Яндекс Метрика", ok: metrika.kind === "oauth" || metrika.kind === "env", detail: metrikaDetail, action: <a href="#metrika" className="text-sm text-accent hover:underline">Настроить</a> },
    { name: "S3 для сырья", ok: cfg.s3Configured, detail: cfg.s3Configured ? "S3" : `локальная папка ${process.env.RAW_DIR ?? "/data/raw"}`, action: null },
  ];
  return (
    <>
      <Section title="Подключения" sub="AdSpyglass и S3 — из .env на сервере, здесь только статус. Метрика подключается ниже: её секреты лежат в базе зашифрованными ключом сервера (ADR 0018)">
        <ul className="-mx-5 divide-y divide-border">{conn.map((c) => (
          <li key={c.name} className="flex flex-wrap items-center gap-3 px-5 py-3">
            <span className={`size-2 rounded-full ${c.ok ? "bg-positive" : "bg-border-strong"}`} />
            <div className="min-w-0 flex-1"><div className="text-sm font-medium">{c.name}</div><div className="text-xs text-muted">{c.detail}</div></div>
            {c.action}
          </li>
        ))}</ul>
      </Section>

      <div id="metrika" className="scroll-mt-20">
      <Section title="Яндекс Метрика" sub={`Приложение из oauth.yandex.ru с доступом «Метрика: получение статистики, чтение параметров счётчиков». ${metrikaCallbackUrl(cfg) ? "Нажмите «Подключить через Яндекс» — согласие и возврат в приложение; в Redirect URI приложения Яндекса должен быть адрес из подсказки ниже. Запасной путь — вставить код руками." : "Код подтверждения Яндекс показывает на своей странице — вставьте его сюда."} Счётчики подбираются по доменам наших сайтов; чужие не заводятся`}>
        <MetrikaBlock status={metrika.kind === "oauth" ? { kind: "oauth", expiresAt: metrika.expiresAt?.toISOString() ?? null, connectedAt: metrika.connectedAt?.toISOString() ?? null }
          : metrika.kind === "broken" ? { kind: "broken", error: metrika.error } : { kind: metrika.kind }}
          authorizeHref={metrika.kind === "app" || metrika.kind === "oauth" ? authorizeUrl(metrika.clientId) : null}
          connectHref={metrikaCallbackUrl(cfg) && (metrika.kind === "app" || metrika.kind === "oauth") ? withBase("/api/metrika/oauth/start") : null}
          callbackUri={metrikaCallbackUrl(cfg)} notice={sp.connected === "1" ? { kind: "ok", text: "Метрика подключена — нажмите «Подтянуть счётчики»" } : sp.metrika_error ? { kind: "error", text: sp.metrika_error } : null} />
      </Section>
      </div>

      <Section title="Разрезы ADOK" sub={`План запросов к AdSpyglass на сутки: какие разрезы по каждому сайту тянет ночной джоб, за сколько прошлых дней, и перечитывать ли вчера почасовыми итогами. ${budget.unlimited ? "Суточного лимита нет" : `Бюджет ${budget.limit} запросов в сутки`} (блок «Лимиты AdSpyglass» ниже); что не занято планом, достаётся бэкфиллу`}>
        <CutsPlanner plan={plan} cuts={CUTS.map((c) => ({ key: c.key, title: c.title, what: c.what, required: Boolean(c.required) }))} sites={Math.max(1, asgSites)} budget={budget.limit} />
      </Section>

      <Section title="Лимиты AdSpyglass" sub="Суточный бюджет — наш предохранитель: ADOK лимита не задаёт, но блокирует частые запросы, поэтому один запрос за раз и пауза между ними остаются всегда">
        <div className="num grid gap-4 text-sm sm:grid-cols-3">
          <div><div className="text-xs text-muted">Запросов сегодня (UTC)</div><div className="text-lg font-semibold" data-testid="asg-used">{used}{budget.unlimited ? <span className="ml-1 text-sm font-normal text-muted">без лимита</span> : <> / {budget.limit}</>}</div>
            {!budget.unlimited && <div className="mt-1 h-1.5 rounded-full bg-surface-hover"><div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, (used / budget.limit) * 100)}%` }} /></div>}
            <BudgetForm daily={budget.unlimited ? 0 : budget.limit} /></div>
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
          <h3 className="mb-1 text-sm font-medium">Бэкфилл AdSpyglass</h3>
          <p className="mb-3 text-xs text-muted">Догружает прошлые дни от новых к старым порциями под дневной бюджет (плану выше остаётся его резерв — {cost.reserve} запросов): джоба проверяет окно каждые 30 минут и продолжает на следующие сутки сама. «Все разрезы» — разрезы из плана, зоны и расход ({cost.perDay} запросов на день для {asgSites || 1} сайтов); «только итоги по сайтам» — один запрос на день, хватает для графиков, прогноза и сравнения месяцев. В конце пересчитывает прогноз дилов и алерты за окно.</p>
          <BackfillBlock state={backfillView} sites={sites.map((s) => ({ id: s.id, domain: s.domain }))} defaults={{ full: defaultWindow(today, "full"), totals: defaultWindow(today, "totals") }} perNight={perNight} />
        </div>
        <div className="border-t border-border pt-4">
          <h3 className="mb-2 text-sm font-medium">Ручной перезапуск</h3>
          <RunJobForm jobs={Object.entries(JOB_LABEL).map(([id, label]) => ({ id, label }))} sites={sites.map((s) => ({ id: s.id, domain: s.domain }))} />
        </div>
      </Section>

      <Section title="Лог за 7 дней">
        {runs.length === 0 ? <p className="text-sm text-muted">Запусков не было</p> : (
          <div className="-mx-5 overflow-x-auto">
            <TableScroll flush><table className="tbl num w-full text-[13px]">
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
            </table></TableScroll>
          </div>
        )}
      </Section>

      <section id="geo" className="scroll-mt-6">
        <Section title="Нераспознанные гео" sub={<>Строк в XX за 7 дней: <span className={xx.all && xx.xx / xx.all >= 0.01 ? "text-warning" : ""}>{xx.all ? ((xx.xx / xx.all) * 100).toFixed(2) : "0"}%</span> (цель — меньше 1%). После сопоставления «Пересчитать» перезапишет строки из сохранённого сырья, без повторного обхода API</>}
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
