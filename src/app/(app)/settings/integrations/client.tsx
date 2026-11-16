"use client";
import { useState, useTransition } from "react";
import { ActionForm, FormField } from "@/components/forms/action-form";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Confirm } from "@/components/ui/sheet";
import { useToast } from "@/components/ui/toast";
import { applyMetrikaCountersAction, cancelBackfillAction, connectMetrikaAction, demoAction, disconnectMetrikaAction, mapAliasAction, metrikaCountersAction, resumeAsgAction, runJobAction,
  saveAsgBudgetAction, saveAsgPlanAction, saveAsgSpeedAction, disconnectTelegramAction, findTelegramChatsAction, previewDigestAction,
  saveTelegramSettingsAction, saveTelegramTokenAction, sendDigestNowAction, saveTelegramProxyAction, checkTelegramLinkAction, saveMetrikaAppAction, startBackfillAction, testAsgAction } from "@/server/actions/settings";
import { RESTATE_CHOICES, UNLIMITED, planCost, type AsgPlan, type CutKey } from "@/server/ingest/adspyglass/plan";
import { DECISION_LABEL, type MatchRow } from "@/server/domain/metrika-match";
import { fmtDate } from "@/lib/format";

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
        <FormField name="confirm" label="Бэкфилл" className="sm:col-span-2 lg:col-span-4" hint="Каждый день окна стоит столько запросов, сколько задано планом «Разрезы ADOK» (2 на день + разрезы × сайтов). Для окна длиннее пары дней используйте блок «Бэкфилл AdSpyglass» — он сам делит работу по суткам.">
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

type Mode = "full" | "core" | "totals";
export interface BackfillView { from: string; to: string; mode: Mode; stage: 1 | 2 | null; siteDomain: string | null; total: number; done: number; failed: number; pending: number; updatedAt: string; lastStop: string | null; cancelled: boolean }
type Win = { from: string; to: string };
const MODE_LABEL = { full: "все разрезы", core: "сайты, сетки, деньги и расход", totals: "только итоги по сайтам" } as const;
const STAGE_LABEL = { 1: "этап 1 из 2: сайты, сетки, деньги и расход", 2: "этап 2 из 2: остальные разрезы" } as const;

/** «Бэкфилл AdSpyglass»: mode + window form, progress of the running one, cancel. */
export function BackfillBlock({ state, sites, defaults, perNight }: { state: BackfillView | null; sites: { id: string; domain: string }[]; defaults: Record<Mode, Win>; perNight: Record<Mode, number> }) {
  const { pending, run } = useRun();
  const running = state && !state.cancelled && state.pending > 0;
  const [mode, setMode] = useState<Mode>(state && !state.cancelled ? state.mode : "full");
  const [win, setWin] = useState<Win>(state && !state.cancelled ? { from: state.from, to: state.to } : defaults.full);
  const pick = (m: Mode) => { setMode(m); setWin(defaults[m]); };
  return (
    <div className="flex flex-col gap-4">
      {state && !state.cancelled && (
        <div className="rounded-lg border border-border p-3 text-sm" data-testid="backfill-progress">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-medium">{state.from} — {state.to}{state.siteDomain ? ` · ${state.siteDomain}` : ""}</span>
            <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted" data-testid="backfill-stage">{state.stage ? STAGE_LABEL[state.stage] : MODE_LABEL[state.mode]}</span>
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
          <Select name="mode" value={mode} onChange={(e) => pick(e.target.value as Mode)}>
            <option value="full">Все разрезы (по плану «Разрезы ADOK»)</option>
            <option value="core">Сайты, сетки, деньги и расход — потом остальные разрезы</option>
            <option value="totals">Только итоги по сайтам (1 запрос в день)</option>
          </Select>
        </FormField>
        <FormField name="from" label="С"><Input type="date" name="from" value={win.from} onChange={(e) => setWin({ ...win, from: e.target.value })} required /></FormField>
        <FormField name="to" label="По" hint={perNight[mode] >= 1000 ? "без суточного лимита — всё окно за один заход" : `≈ ${perNight[mode]} дн. в сутки при текущем бюджете и резерве`}><Input type="date" name="to" value={win.to} onChange={(e) => setWin({ ...win, to: e.target.value })} required /></FormField>
        <FormField name="siteId" label="Сайт (опционально)"><Select name="siteId" defaultValue=""><option value="">Все</option>{sites.map((s) => <option key={s.id} value={s.id}>{s.domain}</option>)}</Select></FormField>
      </ActionForm>
    </div>
  );
}

export type MetrikaView = { kind: "none" | "env" | "app" } | { kind: "oauth"; expiresAt: string | null; connectedAt: string | null } | { kind: "broken"; error: string };

/** «Яндекс Метрика»: the OAuth app → the confirmation code → the counters matched to our sites → apply. */
export function MetrikaBlock({ status, authorizeHref, connectHref = null, callbackUri = null, notice = null }: { status: MetrikaView; authorizeHref: string | null; connectHref?: string | null; callbackUri?: string | null; notice?: { kind: "ok" | "error"; text: string } | null }) {
  const { pending, run } = useRun();
  const [rows, setRows] = useState<MatchRow[] | null>(null);
  const [editApp, setEditApp] = useState(status.kind === "none" || status.kind === "env" || status.kind === "broken");
  const [confirm, setConfirm] = useState(false);
  const matched = rows?.filter((r) => r.decision === "matched") ?? [];
  const takeRows = (r: { data?: Record<string, unknown> }) => { if (Array.isArray(r.data?.rows)) setRows(r.data!.rows as MatchRow[]); };
  return (
    <div className="flex flex-col gap-4" data-testid="metrika-block">
      {status.kind === "broken" && <p className="rounded-md bg-negative-soft px-3 py-2 text-sm text-negative">{status.error}</p>}
      {notice && <p className={`rounded-md px-3 py-2 text-sm ${notice.kind === "ok" ? "bg-positive-soft text-positive" : "bg-negative-soft text-negative"}`} data-testid="metrika-notice">{notice.text}</p>}
      {status.kind === "env" && <p className="text-sm text-muted">Сейчас работает токен из `.env` (METRIKA_TOKEN). Подключение через приложение заменит его и позволит подтягивать счётчики.</p>}
      {(editApp || status.kind === "none") ? (
        <ActionForm action={saveMetrikaAppAction} submit="Сохранить приложение" submitSize="sm" onDone={() => setEditApp(false)} className="grid items-end gap-3 sm:grid-cols-2 [&>div:last-child]:col-span-full"
          cancel={status.kind === "app" || status.kind === "oauth" ? () => setEditApp(false) : undefined}>
          <FormField name="clientId" label="ID приложения" hint="ClientID со страницы приложения в oauth.yandex.ru"><Input name="clientId" autoComplete="off" className="font-mono" /></FormField>
          <FormField name="clientSecret" label="Секрет приложения" hint="Client secret; хранится зашифрованным, в интерфейсе не показывается"><Input name="clientSecret" type="password" autoComplete="new-password" className="font-mono" /></FormField>
        </ActionForm>
      ) : (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          {status.kind === "oauth" ? <span>Подключена{status.connectedAt ? ` ${fmtDate(status.connectedAt)}` : ""}{status.expiresAt ? ` · токен действует до ${fmtDate(status.expiresAt)}` : ""}</span> : <span className="text-muted">Приложение сохранено, токена ещё нет.</span>}
          <Button size="sm" variant="ghost" onClick={() => setEditApp(true)}>Сменить приложение</Button>
          {status.kind === "oauth" && <Button size="sm" variant="ghost" onClick={() => setConfirm(true)}>Отключить</Button>}
        </div>
      )}
      {!editApp && authorizeHref && (
        <div className="rounded-lg border border-border p-3">
          {connectHref && (
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <Button asChild variant="primary" size="sm"><a href={connectHref} data-testid="metrika-connect">{status.kind === "oauth" ? "Переподключить через Яндекс" : "Подключить через Яндекс"}</a></Button>
              <span className="text-xs text-muted">войти под аккаунтом со счётчиками, нажать «Разрешить» — и вы вернётесь сюда</span>
              {callbackUri && <span className="w-full text-xs text-faint">Redirect URI в приложении Яндекса: <code className="select-all">{callbackUri}</code></span>}
            </div>
          )}
          <p className="text-sm">{connectHref ? "Или вручную: " : status.kind === "oauth" ? "Переподключить: " : "Шаг 2. "}<a href={authorizeHref} target="_blank" rel="noreferrer" className="text-accent hover:underline">Получить код в Яндексе ↗</a> — войти под аккаунтом, где лежат счётчики, разрешить доступ и скопировать код.</p>
          <ActionForm action={connectMetrikaAction} submit={status.kind === "oauth" ? "Переподключить" : "Подключить"} submitSize="sm" onDone={takeRows} className="mt-2 grid items-end gap-3 sm:grid-cols-[1fr_auto] [&>div:last-child]:col-span-full">
            <FormField name="code" label="Код подтверждения"><Input name="code" inputMode="numeric" autoComplete="one-time-code" className="num" /></FormField>
          </ActionForm>
        </div>
      )}
      {status.kind === "oauth" && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={pending} onClick={() => run(async () => { const r = await metrikaCountersAction(); takeRows(r); return r; })}>{pending ? "Читаем…" : "Подтянуть счётчики"}</Button>
          {matched.length > 0 && <Button size="sm" variant="primary" disabled={pending} onClick={() => run(async () => { const r = await applyMetrikaCountersAction(matched.map((m) => ({ siteId: m.siteId, counterId: m.counterId! }))); if (r.ok) setRows(null); return r; })}>Применить {matched.length}</Button>}
        </div>
      )}
      {rows && (
        <div className="-mx-5 overflow-x-auto">
          <table className="tbl w-full text-sm" data-testid="metrika-matches">
            <thead><tr className="text-left text-xs text-muted"><th className="px-5 py-1.5 font-medium">Сайт</th><th className="px-3 py-1.5 font-medium">Сейчас</th><th className="px-3 py-1.5 font-medium">Счётчик в Метрике</th><th className="px-3 py-1.5 font-medium">Решение</th></tr></thead>
            <tbody>{[...rows].sort((a, b) => order(a) - order(b)).map((r) => (
              <tr key={r.siteId} className="border-t border-border/60" data-decision={r.decision}>
                <td className="px-5 py-1.5 font-mono">{r.domain}</td>
                <td className="num px-3 py-1.5">{r.metrikaId ?? <span className="text-faint">—</span>}</td>
                <td className="num px-3 py-1.5">{r.counters.length ? r.counters.map((c) => `${c.id} · ${c.name}`).join("; ") : <span className="text-faint">—</span>}</td>
                <td className={`px-3 py-1.5 ${r.decision === "matched" ? "text-positive" : r.decision === "conflict" || r.decision === "ambiguous" ? "text-warning" : "text-muted"}`}>{DECISION_LABEL[r.decision]}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <Confirm open={confirm} onOpenChange={setConfirm} title="Отключить Метрику?" destructive confirmLabel="Отключить"
        body="Токен и приложение будут забыты; счётчики у сайтов останутся, но трафик перестанет загружаться, пока Метрику не подключат снова." onConfirm={() => run(disconnectMetrikaAction)} />
    </div>
  );
}
const ORDER: Record<MatchRow["decision"], number> = { matched: 0, ambiguous: 1, conflict: 2, same: 3, none: 4 };
const order = (r: MatchRow) => ORDER[r.decision];

/** «Разрезы ADOK»: toggles per cut with what each buys, the restate window, the hourly mode — and the live cost against the budget. */
export function CutsPlanner({ plan, cuts, sites, budget }: { plan: AsgPlan; cuts: { key: CutKey; title: string; what: string; required: boolean }[]; sites: number; budget: number }) {
  const [draft, setDraft] = useState<AsgPlan>(plan);
  const cost = planCost(draft, sites, budget);
  const pct = Math.min(100, Math.round((cost.total / budget) * 100));
  const unlimited = budget >= UNLIMITED;
  return (
    <ActionForm action={saveAsgPlanAction} submit="Сохранить план" submitSize="sm" className="flex flex-col gap-4" >
      <div className="grid gap-4 lg:grid-cols-[1fr_280px]">
        <ul className="divide-y divide-border rounded-lg border border-border" data-testid="asg-cuts">
          {cuts.map((c) => (
            <li key={c.key} className="flex items-start gap-3 px-3 py-2 text-sm">
              <input type="checkbox" name={`cut:${c.key}`} value="1" id={`cut-${c.key}`} className="mt-1" checked={draft.cuts[c.key]} disabled={c.required}
                onChange={(e) => setDraft({ ...draft, cuts: { ...draft.cuts, [c.key]: e.target.checked } })} />
              <label htmlFor={`cut-${c.key}`} className="min-w-0 flex-1">
                <span className="font-medium">{c.title}</span>{c.required && <span className="ml-2 text-[11px] text-faint">обязателен</span>}
                <span className="block text-xs text-muted">{c.what}</span>
              </label>
              <span className="num shrink-0 text-xs text-muted">{sites} запр./день</span>
            </li>
          ))}
          <li className="flex flex-wrap items-center gap-x-6 gap-y-2 px-3 py-2 text-sm">
            <label className="flex items-center gap-2">Прошлых дней в ночь
              <Select name="restateDays" value={String(draft.restateDays)} onChange={(e) => setDraft({ ...draft, restateDays: Number(e.target.value) })} className="w-20">
                {RESTATE_CHOICES.map((d) => <option key={d} value={d}>{d}</option>)}
              </Select>
            </label>
            <label className="flex items-center gap-2"><input type="checkbox" name="hourlyToday" value="1" checked={draft.hourlyToday} onChange={(e) => setDraft({ ...draft, hourlyToday: e.target.checked })} /> Почасовые итоги — только сегодня <span className="text-xs text-muted">(вчера перечитывает ночной прогон)</span></label>
          </li>
        </ul>
        <div className="num rounded-lg border border-border p-3 text-sm" data-testid="asg-plan-cost">
          <div className="text-xs text-muted">В сутки по плану</div>
          <div className={`text-2xl font-semibold ${cost.over ? "text-negative" : ""}`}>{cost.total} <span className="text-sm font-normal text-muted">{unlimited ? "без лимита" : `из ${budget}`}</span></div>
          {!unlimited && <div className="mt-1 h-1.5 rounded-full bg-surface-hover"><div className={`h-full rounded-full ${cost.over ? "bg-negative" : "bg-accent"}`} style={{ width: `${pct}%` }} /></div>}
          <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted">Ночь: {draft.restateDays} × (2 + {cost.perSite} × {sites})</dt><dd className="text-right">{cost.nightly}</dd>
            <dt className="text-muted">Почасовые итоги</dt><dd className="text-right">{cost.hourly}</dd>
            <dt className="text-muted">Запас на повторы и проверки</dt><dd className="text-right">30</dd>
            <dt className="font-medium">Остаётся бэкфиллу</dt><dd className="text-right font-medium">{unlimited ? "без ограничения" : cost.backfill}</dd>
          </dl>
          {cost.over > 0 && <p className="mt-2 text-xs text-negative">План не влезает в бюджет на {cost.over} запросов: уберите разрез или день.</p>}
        </div>
      </div>
    </ActionForm>
  );
}

/** Our daily ceiling on ADOK requests: a number, or «без лимита» (0). */
export function BudgetForm({ daily }: { daily: number }) {
  const [unlimited, setUnlimited] = useState(daily === 0);
  return (
    <div data-testid="asg-budget">
    <ActionForm action={saveAsgBudgetAction} submit="Сохранить" submitSize="sm" className="mt-3 flex flex-wrap items-end gap-2 [&>div:last-child]:pt-0">
      <FormField name="daily" label="Суточный бюджет"><Input name="daily" inputMode="numeric" defaultValue={daily || ""} disabled={unlimited} className="w-28" placeholder="800" /></FormField>
      <label className="flex h-9 items-center gap-2 text-sm"><input type="checkbox" name="unlimited" value="1" checked={unlimited} onChange={(e) => setUnlimited(e.target.checked)} data-testid="budget-unlimited" /> без лимита</label>
    </ActionForm>
    </div>
  );
}

/** «Лимиты AdSpyglass» → speed preset. */
export function SpeedForm({ preset, options }: { preset: string; options: { value: string; title: string }[] }) {
  return (
    <div data-testid="asg-speed-form">
    <ActionForm action={saveAsgSpeedAction} submit="Сохранить" submitSize="sm" className="mt-3 flex flex-wrap items-end gap-2 [&>div:last-child]:pt-0">
      <FormField name="preset" label="Скорость запросов"><Select name="preset" defaultValue={preset}>{options.map((o) => <option key={o.value} value={o.value}>{o.title}</option>)}</Select></FormField>
    </ActionForm>
    </div>
  );
}

export interface TelegramBlockView { bot: string | null; chatId: string | null; chatTitle: string | null; hour: number; minAmount: number; enabled: boolean; proxy: string | null }
type LinkRow = { step: string; target: string; ok: boolean; ms: number | null; detail: string };
/** A Cloudflare Worker that forwards Bot API calls to api.telegram.org: the path /bot<token>/<method> stays as it is. */
export const WORKER_CODE = `export default {
  async fetch(request) {
    const url = new URL(request.url);
    url.hostname = "api.telegram.org";
    return fetch(new Request(url, request));
  },
};`;
type TgChat = { id: string; title: string; type: string };
const CHAT_KIND: Record<string, string> = { private: "личный чат", group: "группа", supergroup: "группа", channel: "канал" };

/** «Telegram»: the bot token → the chat → when to send → preview and «send now». */
export function TelegramBlock({ view, hours, error = null }: { view: TelegramBlockView | null; hours: number[]; error?: string | null }) {
  const { pending, run } = useRun();
  const toast = useToast();
  const [busy, start] = useTransition();
  const [editToken, setEditToken] = useState(!view);
  const [chats, setChats] = useState<TgChat[] | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const find = () => start(async () => {
    const r = await findTelegramChatsAction();
    if (r.error) return toast(r.error, "error");
    setChats((r.data?.chats as TgChat[]) ?? []);
  });
  const [link, setLink] = useState<LinkRow[] | null>(null);
  const [showWorker, setShowWorker] = useState(false);
  const check = () => start(async () => {
    const r = await checkTelegramLinkAction();
    if (r.error) return toast(r.error, "error");
    setLink((r.data?.rows as LinkRow[]) ?? []);
  });
  const show = () => start(async () => {
    const r = await previewDigestAction();
    if (r.error) return toast(r.error, "error");
    setPreview(String(r.data?.text ?? ""));
  });
  return (
    <div className="flex flex-col gap-4" data-testid="telegram-block">
      {error && <p className="rounded-md bg-negative-soft px-3 py-2 text-sm text-negative">{error}</p>}
      {editToken || !view ? (
        <ActionForm action={saveTelegramTokenAction} submit="Подключить бота" submitSize="sm" onDone={() => setEditToken(false)} cancel={view ? () => setEditToken(false) : undefined}
          className="grid items-end gap-3 sm:grid-cols-[1fr_auto] [&>div:last-child]:col-span-full">
          <FormField name="token" label="Токен бота" hint="@BotFather → /newbot → токен вида 123456789:AA…; хранится зашифрованным, в интерфейсе не показывается">
            <Input name="token" type="password" autoComplete="new-password" className="font-mono" />
          </FormField>
        </ActionForm>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span data-testid="telegram-bot">Бот <a href={`https://t.me/${view.bot}`} target="_blank" rel="noreferrer" className="text-accent hover:underline">@{view.bot}</a></span>
            <span className={view.chatId ? "" : "text-warning"} data-testid="telegram-chat">{view.chatId ? `→ ${view.chatTitle ?? view.chatId}` : "чат не выбран"}</span>
            <Button size="sm" variant="ghost" onClick={() => setEditToken(true)}>Сменить токен</Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(disconnectTelegramAction)}>Отключить</Button>
          </div>
          <div className="rounded-lg border border-border p-3">
            <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
              <Button size="sm" disabled={busy} onClick={find}>{busy ? "Ищем…" : "Найти чат"}</Button>
              <span className="text-xs text-muted">личный чат: откройте бота и нажмите Start. Группа: добавьте бота и отправьте в группе <code className="select-all">/start@{view.bot}</code> — обычные сообщения бот в группе не видит</span>
            </div>
            {chats && !chats.some((c) => c.type !== "private") && <p className="mb-3 text-xs text-warning" data-testid="telegram-no-groups">Групп не найдено. Отправьте в группе <code>/start@{view.bot}</code> и нажмите «Найти чат» ещё раз — или впишите chat id ниже.</p>}
            <ActionForm action={saveTelegramSettingsAction} submit="Сохранить" submitSize="sm" className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-4 [&>div:last-child]:col-span-full">
              <FormField name="chat" label="Куда слать">
                <Select name="chat" defaultValue="" key={chats?.length ?? 0}>
                  <option value="">{view.chatId ? `${view.chatTitle ?? view.chatId} (сейчас)` : chats ? "выберите чат" : "нажмите «Найти чат»"}</option>
                  {(chats ?? []).map((c) => <option key={c.id} value={`${c.id}|${c.title}`}>{c.title} · {CHAT_KIND[c.type] ?? c.type}</option>)}
                </Select>
              </FormField>
              <FormField name="manualChat" label="Или chat id / @username" hint="например −1001234567890; бот должен быть в чате"><Input name="manualChat" autoComplete="off" className="font-mono" placeholder="-100…" /></FormField>
              <FormField name="hour" label="Время, МСК" hint="данные за вчера готовы около 08:00">
                <Select name="hour" defaultValue={String(view.hour)}>{hours.map((h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}</Select>
              </FormField>
              <FormField name="minAmount" label="Порог, $" hint="изменения и просадки меньше — не показывать"><Input name="minAmount" inputMode="numeric" defaultValue={view.minAmount} className="num w-28" /></FormField>
              <label className="flex h-9 items-center gap-2 text-sm"><input type="checkbox" name="enabled" value="1" defaultChecked={view.enabled} data-testid="telegram-enabled" /> отправлять каждый день</label>
            </ActionForm>
          </div>
          <div className="rounded-lg border border-border p-3" data-testid="telegram-proxy">
            <div className="mb-2 flex flex-wrap items-center gap-3 text-sm">
              <span className="font-medium">Связь с Telegram</span>
              <span className="text-muted" data-testid="telegram-route">{view.proxy ? `через ${view.proxy}` : "напрямую"}</span>
              <Button size="sm" disabled={busy} onClick={check}>{busy ? "Проверяем…" : "Проверить связь"}</Button>
            </div>
            {link && (
              <table className="tbl num mb-3 w-full text-[13px]" data-testid="telegram-link">
                <tbody>{link.map((r, i) => (
                  <tr key={i} className="border-b border-border/60">
                    <td className="py-1 pr-3">{r.ok ? "✅" : "❌"} {r.step}</td>
                    <td className="py-1 pr-3 font-mono text-xs text-muted">{r.target}</td>
                    <td className="py-1 pr-3 text-right">{r.ms == null ? "" : `${r.ms} мс`}</td>
                    <td className={`py-1 ${r.ok ? "text-muted" : "text-negative"}`}>{r.detail}</td>
                  </tr>))}</tbody>
              </table>
            )}
            <ActionForm action={saveTelegramProxyAction} submit="Сохранить прокси" submitSize="sm" className="grid items-end gap-3 sm:grid-cols-[1fr_auto] [&>div:last-child]:col-span-full">
              <FormField name="proxy" label="Прокси к Telegram" hint="если хостинг режет api.telegram.org: https://….workers.dev (Cloudflare Worker) или http://user:pass@host:port. Пусто — напрямую">
                <Input name="proxy" autoComplete="off" className="font-mono" placeholder="https://tg-proxy.имя.workers.dev" />
              </FormField>
            </ActionForm>
            <button type="button" className="mt-2 text-xs text-accent hover:underline" onClick={() => setShowWorker(!showWorker)}>{showWorker ? "Скрыть" : "Как сделать воркер в Cloudflare (бесплатно, 3 минуты)"}</button>
            {showWorker && (
              <div className="mt-2 text-xs text-muted" data-testid="telegram-worker">
                <ol className="list-decimal pl-5">
                  <li>dash.cloudflare.com → войти или зарегистрироваться (бесплатно).</li>
                  <li>Workers &amp; Pages → Create → Worker → имя, например tg-proxy → Deploy.</li>
                  <li>Edit code → заменить всё кодом ниже → Deploy.</li>
                  <li>Скопировать адрес вида https://tg-proxy.имя.workers.dev → вставить выше → «Сохранить прокси».</li>
                </ol>
                <pre className="mt-2 select-all whitespace-pre rounded bg-surface-2 p-2 font-mono text-[12px]">{WORKER_CODE}</pre>
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" disabled={busy} onClick={show}>Предпросмотр</Button>
            <Button size="sm" variant="primary" disabled={pending || !view.chatId} onClick={() => run(sendDigestNowAction)}>{pending ? "Отправляем…" : "Отправить сейчас"}</Button>
            {!view.chatId && <span className="text-xs text-muted">выберите чат, чтобы отправить</span>}
          </div>
          {preview != null && <pre className="whitespace-pre-wrap rounded-lg border border-border bg-surface-2 p-3 text-sm" data-testid="telegram-preview">{preview}</pre>}
        </>
      )}
    </div>
  );
}
